/**
 * Turn a human-readable reset string into an absolute time.
 *
 * This module and `limits.ts` are the only two places that depend on Claude
 * Code's wording, so both are isolated and fixture-tested against strings taken
 * from real transcripts. When a string cannot be parsed we return `null` and the
 * caller stops supervising — guessing a boundary is worse than admitting we do
 * not know one.
 *
 * Real forms observed:
 *   "You've hit your session limit · resets 11:30pm (Asia/Calcutta)"
 *   "You've hit your session limit · resets 5am (Asia/Calcutta)"
 *   "You've hit your weekly limit · resets Aug 6, 10:30pm (Asia/Calcutta)"
 */

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** `11:30pm` / `5am` / `12:10am` → minutes past local midnight. */
function parseClock(hourRaw: string, minuteRaw: string | undefined, meridiem: string): number {
  let hour = Number(hourRaw);
  const minute = minuteRaw ? Number(minuteRaw) : 0;
  const isPm = meridiem.toLowerCase() === 'pm';
  if (isPm && hour !== 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  return hour * 60 + minute;
}

/**
 * Parse a same-day/next-day reset such as `resets 11:30pm`.
 *
 * Interpreted in the local timezone, which is what Claude Code displays. If the
 * stated time is already behind `now`, it refers to tomorrow.
 */
export function parseSessionReset(text: string, now: Date): Date | null {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!m) return parse24HourReset(text, now);

  const minutes = parseClock(m[1]!, m[2], m[3]!);
  const reset = new Date(now);
  reset.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  if (reset.getTime() <= now.getTime()) {
    reset.setDate(reset.getDate() + 1);
  }
  return reset;
}

/**
 * A 24-hour clock, for locales where Claude Code prints `resets 23:30`.
 *
 * Without this the string is unparseable, `resetAt` stays null, `pendingResume`
 * is never set, and in-place continuation silently never happens for that user
 * — with nothing said about why.
 */
function parse24HourReset(text: string, now: Date): Date | null {
  const m = /resets\s+([01]?\d|2[0-3]):([0-5]\d)(?!\s*(am|pm))/i.exec(text);
  if (!m) return null;

  const reset = new Date(now);
  reset.setHours(Number(m[1]!), Number(m[2]!), 0, 0);
  if (reset.getTime() <= now.getTime()) reset.setDate(reset.getDate() + 1);
  return reset;
}

/**
 * Parse a dated reset such as `resets Aug 6, 10:30pm`, used by weekly limits.
 *
 * The year is not stated, so we take the current year and roll forward if that
 * would place the reset in the past — which is what happens across New Year.
 */
export function parseDatedReset(text: string, now: Date): Date | null {
  const m = /resets\s+([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!m) return null;

  const month = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
  if (month === undefined) return null;

  const minutes = parseClock(m[3]!, m[4], m[5]!);
  const reset = new Date(now.getFullYear(), month, Number(m[2]!), 0, 0, 0, 0);
  reset.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  if (reset.getTime() <= now.getTime() - 24 * 3600_000) {
    reset.setFullYear(reset.getFullYear() + 1);
  }
  return reset;
}

/** Try the dated form first — it is strictly more specific. */
export function parseAnyReset(text: string, now: Date): Date | null {
  return parseDatedReset(text, now) ?? parseSessionReset(text, now);
}
