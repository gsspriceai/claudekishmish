/**
 * Usage-window arithmetic and the boundary reservation protocol.
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
 *
 * ## Reserve, then claim
 *
 * A boundary must be consumed exactly once, and *only* by an actor that
 * actually sent a request. Marking it consumed at decision time is wrong: the
 * daemon can decide "resume" for a session whose PTY belongs to another
 * process, and a ping can fail. Either way the boundary would be burnt with
 * nothing sent, and the ledger would then report a healthy window that does not
 * exist.
 *
 * So: `reserveBoundary` takes a short-lived, owned hold; `commitClaim` converts
 * it after a request lands; `releaseReservation` gives it back otherwise. A
 * reservation that expires (its owner died mid-attempt) is reclaimable.
 */

import type { WindowLedger } from '../state/schema.js';

export const MINUTE_MS = 60_000;
export const GRID_MS = 10 * MINUTE_MS;
export const WINDOW_MS = 5 * 60 * MINUTE_MS;
/**
 * How long an actor may hold a boundary while trying to act on it.
 *
 * This must comfortably exceed the worst case act phase, or the holder's own
 * request outlives its reservation and a second actor claims the same boundary
 * underneath it. With the ping budget in `ping.ts` (3 attempts, 60s each, 15s
 * and 30s backoff) the worst case is 225s, so 10 minutes leaves ample margin
 * without letting a genuinely dead owner strand a boundary for long.
 */
export const RESERVATION_TTL_MS = 10 * MINUTE_MS;

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
 * A server-stated reset outranks our own arithmetic, but **only until that
 * reset has actually passed**. Without the expiry the ledger freezes forever on
 * the first limit it ever sees: every later turn is offered as `computed` and
 * rejected, `nextBoundary` stays permanently in the past, and the tool
 * evaluates every tick against a boundary that already happened.
 *
 * The ledger also never walks backwards, so a stale transcript read cannot
 * resurrect an expired window.
 */
export function applyObservation(
  ledger: WindowLedger,
  observation: { end: number; start?: number; source: WindowLedger['source'] },
  now: number,
): WindowLedger {
  const incomingIsAuthoritative = observation.source === 'reset-message';
  const heldIsAuthoritative =
    ledger.source === 'reset-message' && ledger.currentEnd !== null && now < ledger.currentEnd;

  if (heldIsAuthoritative && !incomingIsAuthoritative) return ledger;
  if (!incomingIsAuthoritative && ledger.currentEnd !== null && observation.end <= ledger.currentEnd) {
    return ledger;
  }

  const end = observation.end;
  const start = observation.start ?? end - WINDOW_MS;
  return { ...ledger, currentStart: start, currentEnd: end, source: observation.source };
}

/** Is there a live hold on the boundary belonging to someone other than `owner`? */
export function reservedByOther(ledger: WindowLedger, owner: string, now: number): boolean {
  const r = ledger.reservation;
  return r !== null && r.owner !== owner && now < r.expiresAt;
}

/**
 * The next boundary eligible to be claimed, or `null` if there is none.
 *
 * A boundary already in `lastClaimedBoundary` is spent.
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
  return boundary !== null && now >= boundary + Math.max(0, bufferMs);
}

/** Milliseconds until the next boundary is claimable; `null` if unknown. */
export function msUntilBoundary(
  ledger: WindowLedger,
  now: number,
  bufferMs: number,
): number | null {
  const boundary = nextBoundary(ledger);
  if (boundary === null) return null;
  return Math.max(0, boundary + Math.max(0, bufferMs) - now);
}

/** Take an owned, expiring hold on the current boundary. */
export function reserveBoundary(ledger: WindowLedger, owner: string, now: number): WindowLedger {
  const boundary = nextBoundary(ledger);
  if (boundary === null) return ledger;
  return {
    ...ledger,
    reservation: { boundary, owner, expiresAt: now + RESERVATION_TTL_MS },
  };
}

/** Does this actor currently hold the boundary? */
export function holdsReservation(ledger: WindowLedger, owner: string, now: number): boolean {
  const r = ledger.reservation;
  return r !== null && r.owner === owner && now < r.expiresAt;
}

/** Give the boundary back. Only the owner may release its own hold. */
export function releaseReservation(ledger: WindowLedger, owner: string): WindowLedger {
  if (ledger.reservation === null || ledger.reservation.owner !== owner) return ledger;
  return { ...ledger, reservation: null };
}

/**
 * Convert a reservation into a real claim, after a request actually landed.
 *
 * The claim is itself a first message, so it opens a window anchored on the
 * grid at `floor10(claimedAt)`.
 *
 * **Only the holder may commit.** Without that rule, an actor whose reservation
 * lapsed mid-request would commit against a ledger another actor had already
 * advanced, and the old fallback read that *new* `currentEnd` as the boundary it
 * had claimed. The result was `lastClaimedBoundary === currentEnd`, which makes
 * `nextBoundary` return null for ever: the tool goes permanently silent while
 * `ckm status` still shows a healthy window.
 *
 * Returns `committed: false` and an unchanged ledger when the hold is gone —
 * the request was still sent and the window it opened is real, but it is not
 * this actor's to record.
 */
export function commitClaim(
  ledger: WindowLedger,
  owner: string,
  claimedAt: number,
): { ledger: WindowLedger; committed: boolean } {
  if (!holdsReservation(ledger, owner, claimedAt)) {
    return { ledger, committed: false };
  }

  const boundary = ledger.reservation!.boundary;
  const { start, end } = computeWindow(claimedAt);

  return {
    ledger: {
      currentStart: start,
      currentEnd: end,
      // A claim can never be at or after the window it opens. Unreachable while
      // the reservation above is required — `boundary` is the old `currentEnd`
      // and `end` is five hours past it — so this is defence in depth against a
      // future change, not tested behaviour. `repairLedger` is the reachable
      // safety net, and that one is tested.
      lastClaimedBoundary: boundary < end ? boundary : null,
      reservation: null,
      source: 'claim',
    },
    committed: true,
  };
}

/**
 * Undo an impossible ledger.
 *
 * `lastClaimedBoundary >= currentEnd` cannot happen legitimately — a claim
 * opens a window five hours ahead of the boundary it spent. If it is ever seen,
 * the ledger is corrupt and `nextBoundary` would return null for ever, so the
 * claim stamp is dropped and the boundary becomes reachable again. Worst case
 * that costs one extra claim; the alternative is a tool that never acts again.
 */
export function repairLedger(ledger: WindowLedger): WindowLedger {
  if (
    ledger.currentEnd !== null &&
    ledger.lastClaimedBoundary !== null &&
    ledger.lastClaimedBoundary >= ledger.currentEnd
  ) {
    return { ...ledger, lastClaimedBoundary: null };
  }
  return ledger;
}

/** Has the current window already expired as of `now`? */
export function isExpired(ledger: WindowLedger, now: number): boolean {
  return ledger.currentEnd !== null && now >= ledger.currentEnd;
}

/**
 * Rebuild the ledger from raw conversation history.
 *
 * Used to bootstrap a daemon that has never seen a window, and to re-sync after
 * a failure sequence leaves the stored ledger untrustworthy. Windows tile
 * greedily: each turn outside the previous window anchors a new one.
 */
export function deriveLedgerFromTurns(turns: number[]): { start: number; end: number } | null {
  let current: { start: number; end: number } | null = null;
  for (const turn of turns) {
    if (current === null || turn >= current.end) {
      current = computeWindow(turn);
    }
  }
  return current;
}
