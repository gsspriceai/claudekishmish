import { describe, expect, it } from 'vitest';
import { parseAnyReset, parseDatedReset, parseSessionReset } from '../src/claude/resetparse.js';
import { REAL_RESET_STRINGS, REAL_WEEKLY_STRINGS } from './fixtures/real-records.js';

/** Local-time helper so expectations do not depend on the machine's zone. */
function at(y: number, mo: number, d: number, h: number, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

describe('parseSessionReset', () => {
  it('parses every reset string observed in the corpus', () => {
    const now = at(2026, 7, 1, 13, 0);
    for (const text of REAL_RESET_STRINGS) {
      expect(parseSessionReset(text, now), text).not.toBeNull();
    }
  });

  it('lands on the stated wall-clock time', () => {
    const now = at(2026, 7, 1, 20, 13);
    const reset = parseSessionReset("You've hit your session limit · resets 11:30pm (Asia/Calcutta)", now)!;
    expect(reset.getHours()).toBe(23);
    expect(reset.getMinutes()).toBe(30);
    expect(reset.getDate()).toBe(1);
  });

  it('rolls to tomorrow when the stated time has already passed today', () => {
    const now = at(2026, 7, 2, 0, 13);
    const reset = parseSessionReset("You've hit your session limit · resets 4:30am (Asia/Calcutta)", now)!;
    expect(reset.getHours()).toBe(4);
    expect(reset.getDate()).toBe(2);

    const late = at(2026, 7, 2, 23, 0);
    const rolled = parseSessionReset("You've hit your session limit · resets 4:30am (Asia/Calcutta)", late)!;
    expect(rolled.getDate()).toBe(3);
  });

  it('handles bare hours with no minutes', () => {
    const reset = parseSessionReset("resets 5am", at(2026, 7, 15, 0, 45))!;
    expect(reset.getHours()).toBe(5);
    expect(reset.getMinutes()).toBe(0);
  });

  it('maps 12am to midnight and 12pm to noon', () => {
    const midnight = parseSessionReset('resets 12:10am', at(2026, 7, 17, 21, 25))!;
    expect(midnight.getHours()).toBe(0);
    expect(midnight.getMinutes()).toBe(10);

    const noon = parseSessionReset('resets 12:30pm', at(2026, 7, 17, 8, 0))!;
    expect(noon.getHours()).toBe(12);
  });

  it('parses a 24-hour clock, for locales that print one', () => {
    // Unparseable before: resetAt stayed null, pendingResume was never set, and
    // in-place continuation silently never happened for that user.
    const r = parseSessionReset('resets 23:30', at(2026, 8, 10, 14, 0));
    expect(r).not.toBeNull();
    expect(r!.getHours()).toBe(23);
    expect(r!.getMinutes()).toBe(30);
  });

  it('does not mistake a 12-hour string for a 24-hour one', () => {
    const r = parseSessionReset('resets 11:30pm', at(2026, 8, 10, 14, 0))!;
    expect(r.getHours()).toBe(23);
  });

  it('returns null rather than guessing when there is no reset', () => {
    expect(parseSessionReset('You have reached your Fable 5 limit.', new Date())).toBeNull();
    expect(parseSessionReset('resets soon', new Date())).toBeNull();
  });

  it('always produces a time on the 10-minute grid for corpus strings', () => {
    // Every reset observed across 90 real records landed on {:00,:10,...,:50}.
    const now = at(2026, 7, 1, 12, 0);
    for (const text of REAL_RESET_STRINGS) {
      const reset = parseSessionReset(text, now)!;
      expect(reset.getMinutes() % 10, text).toBe(0);
    }
  });
});

describe('parseDatedReset', () => {
  it('parses the weekly form', () => {
    const now = at(2026, 7, 29, 12, 33);
    const reset = parseDatedReset(REAL_WEEKLY_STRINGS[0], now)!;
    expect(reset.getMonth()).toBe(6); // July
    expect(reset.getDate()).toBe(30);
    expect(reset.getHours()).toBe(22);
    expect(reset.getMinutes()).toBe(30);
  });

  it('parses the second observed weekly string', () => {
    const now = at(2026, 8, 5, 14, 42);
    const reset = parseDatedReset(REAL_WEEKLY_STRINGS[1], now)!;
    expect(reset.getMonth()).toBe(7); // August
    expect(reset.getDate()).toBe(6);
    expect(reset.getHours()).toBe(22);
  });

  it('rolls the year forward across New Year', () => {
    const now = at(2026, 12, 30, 20, 0);
    const reset = parseDatedReset('resets Jan 2, 10:30pm', now)!;
    expect(reset.getFullYear()).toBe(2027);
  });

  it('ignores a session-form string', () => {
    expect(parseDatedReset(REAL_RESET_STRINGS[0], new Date())).toBeNull();
  });
});

describe('parseAnyReset', () => {
  it('prefers the dated form when both could match', () => {
    const now = at(2026, 8, 5, 14, 42);
    const reset = parseAnyReset(REAL_WEEKLY_STRINGS[1], now)!;
    expect(reset.getDate()).toBe(6);
    expect(reset.getMonth()).toBe(7);
  });

  it('falls back to the session form', () => {
    const now = at(2026, 7, 1, 20, 13);
    expect(parseAnyReset(REAL_RESET_STRINGS[0], now)!.getHours()).toBe(23);
  });
});
