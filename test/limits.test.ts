import { describe, expect, it } from 'vitest';
import {
  classifyLimitText,
  isRateLimitRecord,
  isResumable,
  recordText,
  toLimitEvent,
} from '../src/claude/limits.js';
import {
  chattyRecord,
  DECOY_TEXTS,
  rateLimitRecord,
  REAL_MODEL_STRINGS,
  REAL_RESET_STRINGS,
  REAL_WEEKLY_STRINGS,
} from './fixtures/real-records.js';

describe('isRateLimitRecord', () => {
  it('accepts the authoritative envelope', () => {
    expect(isRateLimitRecord(rateLimitRecord(REAL_RESET_STRINGS[0]))).toBe(true);
  });

  it('rejects every decoy in the corpus', () => {
    // These are real assistant messages and real source code that merely mention
    // limits. Matching on text alone fires on all of them.
    for (const text of DECOY_TEXTS) {
      expect(isRateLimitRecord(chattyRecord(text)), text.slice(0, 40)).toBe(false);
    }
  });

  it('rejects a record that has the error but is not flagged as an API error', () => {
    expect(isRateLimitRecord({ error: 'rate_limit', isApiErrorMessage: false })).toBe(false);
  });
});

describe('classifyLimitText', () => {
  it('classifies every real session string', () => {
    for (const text of REAL_RESET_STRINGS) {
      expect(classifyLimitText(text), text).toBe('session');
    }
  });

  it('classifies every real weekly string', () => {
    for (const text of REAL_WEEKLY_STRINGS) {
      expect(classifyLimitText(text), text).toBe('weekly');
    }
  });

  it('classifies the real per-model string', () => {
    for (const text of REAL_MODEL_STRINGS) {
      expect(classifyLimitText(text), text).toBe('model');
    }
  });

  it('does not classify unrelated text', () => {
    expect(classifyLimitText('Rate limiter using in-memory storage')).toBeNull();
    expect(classifyLimitText('all tests passed')).toBeNull();
  });

  it('never confuses weekly for session', () => {
    // "weekly limit" must win: both strings contain the word "limit", and a
    // weekly cap treated as a session cap would make the tool wait 5h for
    // something days away.
    for (const text of REAL_WEEKLY_STRINGS) {
      expect(classifyLimitText(text)).not.toBe('session');
    }
  });
});

describe('toLimitEvent', () => {
  const now = new Date('2026-07-01T14:43:00.000Z');

  it('produces a session event with an absolute reset', () => {
    const event = toLimitEvent(rateLimitRecord(REAL_RESET_STRINGS[0]), now)!;
    expect(event.kind).toBe('session');
    expect(event.resetAt).not.toBeNull();
    expect(event.resetAt!).toBeGreaterThan(event.detectedAt);
  });

  it('produces a weekly event days out', () => {
    const record = rateLimitRecord(REAL_WEEKLY_STRINGS[1], '2026-08-05T09:12:00.000Z');
    const event = toLimitEvent(record, now)!;
    expect(event.kind).toBe('weekly');
    expect(event.resetAt).not.toBeNull();
  });

  it('produces a model event with no reset at all', () => {
    const event = toLimitEvent(rateLimitRecord(REAL_MODEL_STRINGS[0]), now)!;
    expect(event.kind).toBe('model');
    // Waiting cannot clear a per-model cap, so there must be nothing to wait for.
    expect(event.resetAt).toBeNull();
  });

  it('returns null for non-limit records', () => {
    for (const text of DECOY_TEXTS) {
      expect(toLimitEvent(chattyRecord(text), now)).toBeNull();
    }
  });

  it('uses the record timestamp as the detection time', () => {
    const event = toLimitEvent(rateLimitRecord(REAL_RESET_STRINGS[0], '2026-07-01T14:43:00.000Z'), now)!;
    expect(event.detectedAt).toBe(Date.parse('2026-07-01T14:43:00.000Z'));
  });
});

describe('isResumable', () => {
  const now = new Date('2026-07-01T14:43:00.000Z');

  it('is true only for a session limit with a known reset', () => {
    expect(isResumable(toLimitEvent(rateLimitRecord(REAL_RESET_STRINGS[0]), now)!)).toBe(true);
  });

  it('is false for weekly and model limits', () => {
    expect(isResumable(toLimitEvent(rateLimitRecord(REAL_WEEKLY_STRINGS[0]), now)!)).toBe(false);
    expect(isResumable(toLimitEvent(rateLimitRecord(REAL_MODEL_STRINGS[0]), now)!)).toBe(false);
  });
});

describe('recordText', () => {
  it('joins text parts and ignores non-text content', () => {
    const record = {
      message: {
        content: [
          { type: 'text', text: 'a' },
          { type: 'tool_use', text: 'IGNORED' },
          { type: 'text', text: 'b' },
        ],
      },
    };
    expect(recordText(record)).toBe('ab');
  });

  it('is empty for a record with no content', () => {
    expect(recordText({})).toBe('');
  });
});
