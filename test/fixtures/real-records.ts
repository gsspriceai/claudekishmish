/**
 * Fixtures copied from real Claude Code transcripts.
 *
 * These are verbatim shapes and strings observed in
 * `~/.claude/projects/**\/*.jsonl` across 90 authoritative `rate_limit` records.
 * Tests assert against these rather than against invented examples, because a
 * fixture you made up only tests the shape you expected.
 */

import type { TranscriptRecord } from '../../src/claude/limits.js';

/** Every distinct reset string form seen in the corpus. */
export const REAL_RESET_STRINGS = [
  "You've hit your session limit · resets 11:30pm (Asia/Calcutta)",
  "You've hit your session limit · resets 4:30am (Asia/Calcutta)",
  "You've hit your session limit · resets 6:30pm (Asia/Calcutta)",
  "You've hit your session limit · resets 11:40pm (Asia/Calcutta)",
  "You've hit your session limit · resets 8:20pm (Asia/Calcutta)",
  "You've hit your session limit · resets 5:50pm (Asia/Calcutta)",
  "You've hit your session limit · resets 11:50am (Asia/Calcutta)",
  "You've hit your session limit · resets 5am (Asia/Calcutta)",
  "You've hit your session limit · resets 12:10am (Asia/Calcutta)",
  "You've hit your session limit · resets 8am (Asia/Calcutta)",
  "You've hit your session limit · resets 2pm (Asia/Calcutta)",
  "You've hit your session limit · resets 1:20am (Asia/Calcutta)",
] as const;

export const REAL_WEEKLY_STRINGS = [
  "You've hit your weekly limit · resets Jul 30, 10:30pm (Asia/Calcutta)",
  "You've hit your weekly limit · resets Aug 6, 10:30pm (Asia/Calcutta)",
] as const;

export const REAL_MODEL_STRINGS = [
  "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model",
] as const;

/** The authoritative error envelope, exactly as it appears on disk. */
export function rateLimitRecord(text: string, timestamp = '2026-07-01T14:43:00.000Z'): TranscriptRecord {
  return {
    type: 'assistant',
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    timestamp,
    message: { content: [{ type: 'text', text }] },
  };
}

/**
 * An assistant message that merely *mentions* a limit.
 *
 * The corpus is full of these — summaries, subagent reports, and the project's
 * own source code about HTTP rate limiting. A detector that matches on text
 * alone fires on all of them, which is why `error === 'rate_limit'` is required.
 */
export function chattyRecord(text: string): TranscriptRecord {
  return {
    type: 'assistant',
    timestamp: '2026-07-01T18:02:00.000Z',
    message: { content: [{ type: 'text', text }] },
  };
}

export const DECOY_TEXTS = [
  'The enumeration agent hit the **session usage limit** (resets 11:30pm IST) after ~55 min',
  'Buckets 37 & 38 hit the **session limit** (resets 4:30am IST) mid-run',
  '# Per-user rate limiter for Price Intel.\n# Limits (search): SEARCH_RPM 30 per minute',
  'Rate limiter using in-memory storage (ENV=local)',
] as const;

export function userTurn(timestamp: string): TranscriptRecord {
  return { type: 'user', timestamp, message: { content: [{ type: 'text', text: 'hi' }] } };
}
