/**
 * Classify a Claude Code limit interruption.
 *
 * Three limits exist and they need three different responses. Treating them as
 * one is the mistake that makes a wait-and-retry tool hang for two days on a
 * weekly cap, or spin forever on a per-model cap that no amount of waiting will
 * clear.
 *
 *   session  "You've hit your session limit · resets 11:30pm (Asia/Calcutta)"
 *   weekly   "You've hit your weekly limit · resets Aug 6, 10:30pm (Asia/Calcutta)"
 *   model    "You've reached your Fable 5 limit. Run /usage-credits to continue
 *             or switch models with /model"
 *
 * The `model` case is out of scope by design — but out of scope means *detect
 * and bail cleanly*, never *ignore and hang*.
 */

import type { LimitEvent, LimitKind } from '../state/schema.js';
import { parseAnyReset } from './resetparse.js';

/** A single parsed transcript line, narrowed to what we care about. */
export interface TranscriptRecord {
  type?: string;
  error?: string;
  isApiErrorMessage?: boolean;
  apiErrorStatus?: number;
  timestamp?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
}

/** Is this record the authoritative rate-limit signal? */
export function isRateLimitRecord(record: TranscriptRecord): boolean {
  return record.error === 'rate_limit' && record.isApiErrorMessage === true;
}

/** Concatenate the text parts of a record's message content. */
export function recordText(record: TranscriptRecord): string {
  const parts = record.message?.content ?? [];
  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
}

export function classifyLimitText(text: string): LimitKind | null {
  if (/weekly limit/i.test(text)) return 'weekly';
  if (/session limit/i.test(text)) return 'session';
  // Per-model caps name the model and point at /usage-credits or /model.
  if (/\/usage-credits|switch models|reached your .+ limit/i.test(text)) return 'model';
  return null;
}

/**
 * Build a `LimitEvent` from a transcript record, or `null` when the record is
 * not a limit we recognise.
 *
 * `now` is injected so this stays a pure function and the tests do not need to
 * manipulate the clock.
 */
export function toLimitEvent(record: TranscriptRecord, now: Date): LimitEvent | null {
  if (!isRateLimitRecord(record)) return null;

  const text = recordText(record).trim();
  const kind = classifyLimitText(text);
  if (kind === null) return null;

  const detectedAt = record.timestamp ? Date.parse(record.timestamp) : now.getTime();
  const base = Number.isFinite(detectedAt) ? detectedAt : now.getTime();

  // A model cap states no reset time; waiting for one would hang forever.
  const resetAt = kind === 'model' ? null : (parseAnyReset(text, new Date(base))?.getTime() ?? null);

  return { kind, detectedAt: base, resetAt, raw: text };
}

/** Can this limit be waited out and resumed automatically? */
export function isResumable(event: LimitEvent): boolean {
  return event.kind === 'session' && event.resetAt !== null;
}
