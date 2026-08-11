/**
 * The outage classifier, against the records this machine actually wrote.
 *
 * Every fixture below is a real shape taken from an 84,000-line transcript
 * history, with its real `error` tag and status. The counts are from that same
 * history and are why the taxonomy looks the way it does:
 *
 *   96  rate_limit            429   handled elsewhere — it knows when it lifts
 *   33  authentication_failed  —    terminal; retrying is what makes a tool hated
 *    4  server_error           —    "Response stalled mid-stream"
 *    4  authentication_failed 403   "Please run /login"
 *    2  unknown                —    "Unable to connect to API (ConnectionRefused)"
 *    1  unknown              529    "API Error: Overloaded"
 *    1  oauth_org_not_allowed 403   organisation disabled subscription access
 */

import { describe, expect, it } from 'vitest';
import { nextRetryAt, toOutageEvent } from '../src/claude/outage.js';
import type { TranscriptRecord } from '../src/claude/limits.js';

const NOW = new Date('2026-08-11T10:00:00.000Z');
const BACKOFF = 30_000;

/** A record in the shape Claude Code writes for an API error. */
function apiError(over: Partial<TranscriptRecord> & { text?: string }): TranscriptRecord {
  const { text, ...rest } = over;
  return {
    type: 'assistant',
    isApiErrorMessage: true,
    timestamp: '2026-08-11T09:59:00.000Z',
    message: { content: [{ type: 'text', text: text ?? '' }] },
    ...rest,
  };
}

const at = Date.parse('2026-08-11T09:59:00.000Z');

describe('outages worth retrying', () => {
  it('the classic: API Error: Overloaded, status 529', () => {
    const e = toOutageEvent(apiError({ error: 'unknown', apiErrorStatus: 529, text: 'API Error: Overloaded' }), NOW, BACKOFF);
    expect(e).not.toBeNull();
    expect(e!.status).toBe(529);
    expect(e!.attempts).toBe(0);
    expect(e!.retryAt).toBe(at + BACKOFF);
  });

  it('a stalled stream, which carries no status at all', () => {
    const e = toOutageEvent(
      apiError({ error: 'server_error', text: 'API Error: Response stalled mid-stream. The response above may be incomplete.' }),
      NOW,
      BACKOFF,
    );
    expect(e).not.toBeNull();
    expect(e!.error).toBe('server_error');
    expect(e!.status).toBeNull();
  });

  it('a refused connection, tagged only as unknown', () => {
    const e = toOutageEvent(
      apiError({ error: 'unknown', text: 'API Error: Unable to connect to API (ConnectionRefused)' }),
      NOW,
      BACKOFF,
    );
    expect(e).not.toBeNull();
  });

  it('any 5xx, whatever it is called', () => {
    for (const status of [500, 502, 503, 529]) {
      const e = toOutageEvent(apiError({ error: 'unknown', apiErrorStatus: status, text: 'API Error' }), NOW, BACKOFF);
      expect(e, String(status)).not.toBeNull();
    }
  });

  it('keeps the first line for the log, and only the first', () => {
    const e = toOutageEvent(
      apiError({ error: 'server_error', text: 'API Error: Overloaded\nstack trace nobody needs\nmore noise' }),
      NOW,
      BACKOFF,
    );
    expect(e!.raw).toBe('API Error: Overloaded');
  });
});

describe('what must never be retried', () => {
  it('a usage limit, which has its own path and knows when it lifts', () => {
    // Guessing a backoff here would send request after request into a wall the
    // server already told us the height of.
    const e = toOutageEvent(
      apiError({ error: 'rate_limit', apiErrorStatus: 429, text: "You've hit your session limit · resets 2:50pm (Asia/Calcutta)" }),
      NOW,
      BACKOFF,
    );
    expect(e).toBeNull();
  });

  it('authentication failures — 33 of them in this history', () => {
    for (const rec of [
      apiError({ error: 'authentication_failed', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }),
      apiError({ error: 'authentication_failed', apiErrorStatus: 403, text: 'Please run /login · API Error: 403' }),
    ]) {
      expect(toOutageEvent(rec, NOW, BACKOFF)).toBeNull();
    }
  });

  it('an organisation that has disabled subscription access', () => {
    const e = toOutageEvent(
      apiError({ error: 'oauth_org_not_allowed', apiErrorStatus: 403, text: 'Your organization has disabled Claude subscription access' }),
      NOW,
      BACKOFF,
    );
    expect(e).toBeNull();
  });

  it('any other 4xx, which will fail again identically', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(toOutageEvent(apiError({ error: 'unknown', apiErrorStatus: status, text: 'API Error' }), NOW, BACKOFF), String(status)).toBeNull();
    }
  });

  it('an `unknown` error that is not a transport failure', () => {
    // `unknown` is a grab-bag. Retrying everything in it would retry failures
    // that repeat for ever.
    const e = toOutageEvent(apiError({ error: 'unknown', text: 'API Error: something we have never seen' }), NOW, BACKOFF);
    expect(e).toBeNull();
  });

  it('PROSE that merely talks about these errors', () => {
    // This is not hypothetical. Searching this machine's transcripts for
    // "API Error: 529" returns conversations about error handling — including
    // this project's own documentation. `isApiErrorMessage` is set by Claude
    // Code on records it generated and cannot be produced by anything written
    // in a message.
    const chatter: TranscriptRecord = {
      type: 'assistant',
      timestamp: '2026-08-11T09:59:00.000Z',
      message: {
        content: [{ type: 'text', text: 'Their tool matches API Error: 529 and Overloaded by scraping the screen.' }],
      },
    };
    expect(toOutageEvent(chatter, NOW, BACKOFF)).toBeNull();

    const userSaying: TranscriptRecord = {
      ...chatter,
      type: 'user',
      isApiErrorMessage: false,
    };
    expect(toOutageEvent(userSaying, NOW, BACKOFF)).toBeNull();
  });
});

describe('nextRetryAt', () => {
  it('doubles per attempt', () => {
    expect(nextRetryAt(0, 0, 30_000, 8 * 60_000)).toBe(30_000);
    expect(nextRetryAt(0, 1, 30_000, 8 * 60_000)).toBe(60_000);
    expect(nextRetryAt(0, 2, 30_000, 8 * 60_000)).toBe(120_000);
    expect(nextRetryAt(0, 3, 30_000, 8 * 60_000)).toBe(240_000);
  });

  it('is capped, so a late retry cannot outlive the window it is saving', () => {
    // Unbounded doubling puts attempt 10 eleven hours out — past two whole
    // windows, for a session the user gave up on long before.
    expect(nextRetryAt(0, 10, 30_000, 8 * 60_000)).toBe(8 * 60_000);
    expect(nextRetryAt(0, 40, 30_000, 8 * 60_000)).toBe(8 * 60_000);
  });

  it('never goes backwards on a negative or absurd attempt count', () => {
    expect(nextRetryAt(1_000, -5, 30_000, 8 * 60_000)).toBe(31_000);
  });
});
