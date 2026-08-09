/**
 * Usage-window arithmetic.
 *
 * Pure functions only: no clock, no I/O, no Claude. Everything the tool can get
 * *wrong* about timing lives here, so it can all be tested directly.
 *
 * The model, derived from 90 real `rate_limit` records in local transcripts:
 *
 *     windowStart = floor10(first message after the previous window expired)
 *     windowEnd   = windowStart + 5h
 *
 * Every observed server-stated reset landed on a 10-minute grid — {:00, :10,
 * :20, :30, :40, :50}, zero exceptions — and predicting `windowEnd` from the
 * first message matched the stated reset in 9 of 9 testable cases.
 *
 * The grid is applied to epoch time, i.e. it is a UTC grid. In any zone whose
 * offset is a whole multiple of 10 minutes (which includes UTC+5:30) that is
 * indistinguishable from a local grid. In the handful of zones offset by :45,
 * boundaries will appear at :05/:15/... in local time. Epoch math is used
 * because it is immune to DST and to laptop suspend.
 */

import type { WindowLedger } from '../state/schema.js';

export const MINUTE_MS = 60_000;
export const GRID_MS = 10 * MINUTE_MS;
export const WINDOW_MS = 5 * 60 * MINUTE_MS;

/** Round an epoch time down to the 10-minute grid. */
export function floor10(t: number): number {
  return Math.floor(t / GRID_MS) * GRID_MS;
}

/** Round an epoch time up to the 10-minute grid (already-on-grid stays put). */
export function ceil10(t: number): number {
  return Math.ceil(t / GRID_MS) * GRID_MS;
}

/** The window opened by a first message at `firstMessage`. */
export function computeWindow(firstMessage: number): { start: number; end: number } {
  const start = floor10(firstMessage);
  return { start, end: start + WINDOW_MS };
}

/**
 * Fold an observation into the ledger.
 *
 * A server-stated reset (`source: 'reset-message'`) is authoritative and will
 * not be overwritten by our own arithmetic. Anything else only fills a gap or
 * moves the ledger forward — the ledger never walks backwards, which keeps a
 * stale transcript read from resurrecting an expired window.
 */
export function applyObservation(
  ledger: WindowLedger,
  observation: { end: number; start?: number; source: WindowLedger['source'] },
): WindowLedger {
  const authoritative = observation.source === 'reset-message';
  const held = ledger.source === 'reset-message';

  if (held && !authoritative) return ledger;
  if (!authoritative && ledger.currentEnd !== null && observation.end <= ledger.currentEnd) {
    return ledger;
  }

  const end = observation.end;
  const start = observation.start ?? end - WINDOW_MS;
  return { ...ledger, currentStart: start, currentEnd: end, source: observation.source };
}

/**
 * The next boundary that is eligible to be claimed, or `null` if we do not know
 * of one. A boundary already recorded in `lastClaimedBoundary` is spent.
 */
export function nextBoundary(ledger: WindowLedger): number | null {
  if (ledger.currentEnd === null) return null;
  if (ledger.lastClaimedBoundary !== null && ledger.lastClaimedBoundary >= ledger.currentEnd) {
    return null;
  }
  return ledger.currentEnd;
}

/**
 * Has the next boundary arrived?
 *
 * `bufferMs` fires us slightly *after* the boundary rather than exactly on it —
 * a request a second early just fails, and we would be retrying blind.
 */
export function isBoundaryDue(ledger: WindowLedger, now: number, bufferMs: number): boolean {
  const boundary = nextBoundary(ledger);
  return boundary !== null && now >= boundary + bufferMs;
}

/** Milliseconds until the next boundary is claimable; `null` if unknown. */
export function msUntilBoundary(
  ledger: WindowLedger,
  now: number,
  bufferMs: number,
): number | null {
  const boundary = nextBoundary(ledger);
  if (boundary === null) return null;
  return Math.max(0, boundary + bufferMs - now);
}

/**
 * Record a claim. The window that the claim itself opens starts at
 * `floor10(claimedAt)` — the claim is a first message like any other.
 */
export function recordClaim(ledger: WindowLedger, claimedAt: number): WindowLedger {
  const boundary = ledger.currentEnd;
  const { start, end } = computeWindow(claimedAt);
  return {
    currentStart: start,
    currentEnd: end,
    lastClaimedBoundary: boundary ?? floor10(claimedAt),
    source: 'claim',
  };
}

/** Has the current window already expired as of `now`? */
export function isExpired(ledger: WindowLedger, now: number): boolean {
  return ledger.currentEnd !== null && now >= ledger.currentEnd;
}
