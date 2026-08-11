/**
 * Classify an API failure that stopped a session but will pass on its own.
 *
 * A usage limit is not the only thing that halts work mid-task. The API can be
 * overloaded, a stream can stall, a socket can drop — and unlike a limit, none
 * of these state a reset time. The session simply stops, and the person has to
 * come back and type `continue`. That is the same loss the tool exists to
 * prevent, arriving through a different door.
 *
 * ## Built from what this machine actually recorded
 *
 * Every classification here comes from the real error records in one 84,000-line
 * transcript history, not from a guess at what the API might emit:
 *
 * ```
 *   96  error=rate_limit            status=429   "hit your session limit · resets 2:50pm"
 *   33  error=authentication_failed status=null  "OAuth session expired and could not be refreshed"
 *    4  error=server_error          status=null  "API Error: Response stalled mid-stream."
 *    4  error=authentication_failed status=403   "Please run /login · API Error: 403 ..."
 *    2  error=unknown               status=null  "API Error: Unable to connect to API (ConnectionRefused)"
 *    1  error=unknown               status=529   "API Error: Overloaded"
 *    1  error=oauth_org_not_allowed status=403   "organization has disabled Claude subscription access"
 * ```
 *
 * Two of those rows must never be retried by this code — authentication and the
 * organisation block are terminal, and repeating a request that cannot succeed
 * is what makes a tool hated. `rate_limit` has its own path, which knows how
 * long to wait. What is left is the retryable middle.
 *
 * ## Why the structured fields, and not the text
 *
 * Matching `API Error: 529` in prose finds this machine's own conversations
 * *about* error handling — searching those transcripts for that string returns
 * discussions of rate-limiting code and, memorably, a paragraph of this
 * project's own documentation. `isApiErrorMessage` is set by Claude Code on
 * records it generated itself and cannot be produced by anything a person or a
 * model wrote in a message.
 *
 * Text is consulted only *after* that flag has established the record is a real
 * API error, and only to separate a retryable transport failure from an
 * `unknown` that means something else.
 */

import type { TranscriptRecord } from './limits.js';
import { isRateLimitRecord, recordText } from './limits.js';

/** A stalled session waiting on something that will pass by itself. */
export interface OutageEvent {
  detectedAt: number;
  /** HTTP status, when the record carried one. */
  status: number | null;
  /** Claude Code's own error tag: `server_error`, `unknown`. */
  error: string;
  /** First line of the message, for `ckm status` and the log. */
  raw: string;
  /** Continuations already sent for this outage. Bounded. */
  attempts: number;
  /** Epoch ms before which nothing may be sent. */
  retryAt: number;
}

/**
 * Errors that no amount of waiting can fix.
 *
 * Listed explicitly rather than inferred, so adding a retryable case can never
 * accidentally widen into one of these.
 */
const TERMINAL_ERRORS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'permission_error',
  'invalid_request_error',
]);

/**
 * Transport failures, seen verbatim in real transcripts.
 *
 * Only consulted for an `unknown` error tag, which is a grab-bag: without this
 * the tool would retry anything Claude Code failed to categorise, including
 * failures that will repeat for ever.
 */
const TRANSPORT_PATTERNS: RegExp[] = [
  /\boverloaded\b/i,
  /unable to connect to api/i,
  /connection ?refused/i,
  /socket connection was closed/i,
  /connection closed mid-response/i,
  /response stalled mid-stream/i,
  /\bETIMEDOUT\b|\bECONNRESET\b|\bENOTFOUND\b|\bEAI_AGAIN\b/,
];

function isServerStatus(status: number | null): boolean {
  return status !== null && status >= 500 && status < 600;
}

/**
 * Build an `OutageEvent`, or `null` when this record is not one.
 *
 * `now` is injected so this stays pure and the tests need no clock.
 *
 * @param backoffMs how long to wait before the first continuation.
 */
export function toOutageEvent(
  record: TranscriptRecord,
  now: Date,
  backoffMs: number,
): OutageEvent | null {
  // Only records Claude Code itself marked as an API error. Prose is not
  // evidence — these transcripts contain conversations about these very
  // strings.
  if (record.isApiErrorMessage !== true) return null;

  // A usage limit knows when it lifts; that path waits for the stated reset
  // rather than guessing at a backoff.
  if (isRateLimitRecord(record)) return null;

  const error = typeof record.error === 'string' ? record.error : 'unknown';
  if (TERMINAL_ERRORS.has(error)) return null;

  const status = typeof record.apiErrorStatus === 'number' ? record.apiErrorStatus : null;
  const text = recordText(record).trim();

  // A 4xx is the request's fault and will fail again identically. 429 is the
  // one exception, and it has already been handled above.
  if (status !== null && status >= 400 && status < 500) return null;

  const retryable =
    error === 'server_error' ||
    isServerStatus(status) ||
    (error === 'unknown' && TRANSPORT_PATTERNS.some((p) => p.test(text)));

  if (!retryable) return null;

  const stamped = record.timestamp ? Date.parse(record.timestamp) : NaN;
  const detectedAt = Number.isFinite(stamped) ? stamped : now.getTime();

  return {
    detectedAt,
    status,
    error,
    raw: firstLine(text),
    attempts: 0,
    retryAt: detectedAt + backoffMs,
  };
}

function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 200);
  }
  return text.slice(0, 200);
}

/**
 * When may attempt number `attempts` be sent?
 *
 * Doubling from the base, capped, so a genuine outage is not hammered: with the
 * defaults that is 30s, 1m, 2m, 4m, 8m. The cap matters more than the growth —
 * an unbounded doubling would put the fifth retry beyond the window it was
 * trying to save.
 */
export function nextRetryAt(
  from: number,
  attempts: number,
  baseMs: number,
  capMs: number,
): number {
  const grown = baseMs * 2 ** Math.max(0, attempts);
  return from + Math.min(grown, capMs);
}
