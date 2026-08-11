/**
 * Keep the ledger honest by re-deriving it from what actually happened.
 *
 * ## The failure this exists to prevent
 *
 * The ledger used to advance only by this tool's own claims, and every claim
 * was assumed to start a new window: `windowStart = floor10(claimTime)`. That
 * is only true when the claim is *the first message after the previous window
 * expired*. A human typing before us starts the window instead, and then our
 * "claim at the boundary" lands in the middle of a window that is already
 * running — where it starts nothing, buys nothing, and leaves the ledger
 * describing a window that does not exist.
 *
 * Observed on a real machine on 2026-08-11: the true window ran 07:10 → 12:10
 * (anchored by the user's own 07:13 message), the ledger claimed 11:50 → 16:50,
 * and the boundary the tool exists to catch went by unnoticed. The error also
 * could not heal: each claim re-anchored on the previous claim, so the phase
 * error was carried forward for ever.
 *
 * ## Why derivation is trusted over our own arithmetic
 *
 * `deriveLedgerFromTurns` walks every user turn on the machine and re-anchors
 * only at a turn that falls at or after the running window's end — the verified
 * model, applied to evidence rather than to an assumption. Run against that same
 * machine it reproduced 07:10 → 12:10 and 12:10 → 17:10 exactly, matching what
 * Claude Code's own usage panel reported.
 *
 * ## Why this cannot simply call `applyObservation`
 *
 * That function refuses any non-authoritative observation that would move the
 * end *earlier* — "the ledger never walks backwards" — which is right for a
 * stale transcript read resurfacing an expired window, and is precisely what
 * made the wrong ledger permanent. The distinction it was missing:
 *
 *   - an observation whose window **contains now** is a statement about the
 *     present, and outranks anything we merely inferred;
 *   - an observation whose window has **already ended** is stale, and is
 *     ignored no matter what.
 *
 * A server-stated reset (`reset-message`) still outranks derivation while it is
 * current: it comes from the only party that actually knows.
 */

import type { WindowLedger } from '../state/schema.js';
import { deriveLedgerFromTurns } from './ledger.js';

export interface Reconciliation {
  ledger: WindowLedger;
  /** True when the derived window disagreed with what we believed. */
  corrected: boolean;
  /** Human-readable reason, for the log. Empty when nothing changed. */
  reason: string;
}

/**
 * Fold derived evidence into the ledger.
 *
 * @param turns  every user-turn timestamp on the machine, ascending.
 */
export function reconcileLedger(
  ledger: WindowLedger,
  turns: number[],
  now: number,
): Reconciliation {
  const unchanged = { ledger, corrected: false, reason: '' };

  const derived = deriveLedgerFromTurns(turns);
  if (derived === null) return unchanged;

  // Stale evidence. The last turn on the machine is old enough that its window
  // has expired, so it says nothing about now.
  if (derived.end <= now) return unchanged;

  // The server told us, and its answer has not yet expired. It knows; we infer.
  if (ledger.source === 'reset-message' && ledger.currentEnd !== null && now < ledger.currentEnd) {
    return unchanged;
  }

  if (ledger.currentEnd === derived.end && ledger.currentStart === derived.start) {
    return unchanged;
  }

  // A boundary recorded as claimed can only refer to a window that has since
  // ended. Carrying a claim that sits at or beyond the corrected end would make
  // `nextBoundary` return null for ever — the ledger would look healthy and
  // never act again.
  const lastClaimedBoundary =
    ledger.lastClaimedBoundary !== null && ledger.lastClaimedBoundary >= derived.end
      ? null
      : ledger.lastClaimedBoundary;

  const had = ledger.currentEnd;
  return {
    ledger: {
      ...ledger,
      currentStart: derived.start,
      currentEnd: derived.end,
      source: 'computed',
      lastClaimedBoundary,
    },
    corrected: true,
    reason:
      had === null
        ? 'no window was known; derived one from conversation history'
        : `believed the window ended ${new Date(had).toISOString()}, evidence says ${new Date(derived.end).toISOString()}`,
  };
}
