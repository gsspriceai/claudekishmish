/**
 * The ledger must be able to admit it was wrong.
 *
 * Every case here is built from one real failure, seen on the author's machine
 * on 2026-08-11. The true window ran 07:10 → 12:10, anchored by the user's own
 * 07:13 message. The ledger said 11:50 → 16:50, because it had advanced purely
 * by its own claims and every claim was assumed to open a new window. So the
 * tool sat through the 12:10 boundary — the one thing it exists to catch — while
 * `ckm status` reported a healthy window 4h 44m away.
 *
 * Timestamps are epoch arithmetic, never local strings: the 10-minute grid is
 * defined on epoch ms, and a test that formatted local times would pass or fail
 * depending on the machine's offset.
 */

import { describe, expect, it } from 'vitest';
import { reconcileLedger } from '../src/window/reconcile.js';
import { computeWindow, WINDOW_MS } from '../src/window/ledger.js';
import type { WindowLedger } from '../src/state/schema.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A round epoch on the 10-minute grid, so windows tile exactly. */
const T0 = 1_786_000_000_000 - (1_786_000_000_000 % (10 * MINUTE));

function ledgerOf(over: Partial<WindowLedger> = {}): WindowLedger {
  return {
    currentStart: null,
    currentEnd: null,
    lastClaimedBoundary: null,
    reservation: null,
    source: null,
    ...over,
  };
}

describe('reconcileLedger — the 2026-08-11 failure', () => {
  // The user's first message after the previous window expired.
  const humanTurn = T0 + 3 * MINUTE + 33_000; // 07:13:33 in the real incident
  const trueWindow = computeWindow(humanTurn); // 07:10 → 12:10
  // Our own claim, fired 20 minutes early against a window we had mis-phased,
  // landing inside the window that was already running.
  const badClaim = trueWindow.end - 11 * MINUTE;

  it('corrects a window this tool invented from its own claim', () => {
    const wrong = computeWindow(badClaim); // 11:50 → 16:50
    expect(wrong.end).toBeGreaterThan(trueWindow.end); // the bug, restated

    const before = ledgerOf({
      currentStart: wrong.start,
      currentEnd: wrong.end,
      source: 'claim',
    });

    const after = reconcileLedger(before, [humanTurn, badClaim], badClaim + MINUTE);

    expect(after.corrected).toBe(true);
    expect(after.ledger.currentEnd).toBe(trueWindow.end);
    expect(after.ledger.currentStart).toBe(trueWindow.start);
    expect(after.ledger.source).toBe('computed');
  });

  it('moves the end EARLIER, which the old rule forbade outright', () => {
    // `applyObservation` refuses any non-authoritative observation that would
    // walk the ledger backwards. That guard is right for a stale read and is
    // exactly what made this wrong ledger permanent.
    const before = ledgerOf({
      currentStart: trueWindow.end - WINDOW_MS + 20 * MINUTE,
      currentEnd: trueWindow.end + 4 * HOUR,
      source: 'claim',
    });

    const after = reconcileLedger(before, [humanTurn], trueWindow.end - HOUR);
    expect(after.ledger.currentEnd).toBe(trueWindow.end);
  });

  it('clears a claimed boundary that the correction puts out of reach', () => {
    // Left in place, `lastClaimedBoundary >= currentEnd` makes `nextBoundary`
    // return null for ever: the ledger looks healthy and never acts again.
    const before = ledgerOf({
      currentStart: trueWindow.end,
      currentEnd: trueWindow.end + WINDOW_MS,
      lastClaimedBoundary: trueWindow.end + 2 * HOUR,
      source: 'claim',
    });

    const after = reconcileLedger(before, [humanTurn], trueWindow.start + HOUR);
    expect(after.ledger.currentEnd).toBe(trueWindow.end);
    expect(after.ledger.lastClaimedBoundary).toBeNull();
  });

  it('keeps a claimed boundary that is still consistent', () => {
    const before = ledgerOf({
      currentStart: trueWindow.start,
      currentEnd: trueWindow.end + HOUR, // slightly wrong
      lastClaimedBoundary: trueWindow.start,
      source: 'claim',
    });

    const after = reconcileLedger(before, [humanTurn], trueWindow.start + HOUR);
    expect(after.ledger.lastClaimedBoundary).toBe(trueWindow.start);
  });
});

describe('reconcileLedger — what must NOT be believed', () => {
  const turn = T0;
  const window = computeWindow(turn);

  it('ignores evidence whose window has already ended', () => {
    // Yesterday's transcript must never resurrect an expired window; that is
    // the failure the "never walk backwards" rule was written for.
    const before = ledgerOf({
      currentStart: window.end,
      currentEnd: window.end + WINDOW_MS,
      source: 'claim',
    });

    const after = reconcileLedger(before, [turn], window.end + HOUR);
    expect(after.corrected).toBe(false);
    expect(after.ledger).toBe(before);
  });

  it('defers to a server-stated reset that has not expired', () => {
    // The server is the only party that actually knows. We infer.
    const before = ledgerOf({
      currentStart: window.start + 30 * MINUTE,
      currentEnd: window.end + 30 * MINUTE,
      source: 'reset-message',
    });

    const after = reconcileLedger(before, [turn], window.start + HOUR);
    expect(after.corrected).toBe(false);
  });

  it('overrides a server-stated reset once it HAS expired', () => {
    // Otherwise the first limit message ever seen freezes the ledger for good.
    const stale = ledgerOf({
      currentStart: turn - WINDOW_MS,
      currentEnd: turn - MINUTE,
      source: 'reset-message',
    });

    const after = reconcileLedger(stale, [turn], turn + HOUR);
    expect(after.corrected).toBe(true);
    expect(after.ledger.currentEnd).toBe(window.end);
  });

  it('does nothing when there is no history at all', () => {
    const before = ledgerOf({ currentStart: window.start, currentEnd: window.end, source: 'claim' });
    expect(reconcileLedger(before, [], window.start + HOUR).corrected).toBe(false);
  });

  it('does not churn when evidence and ledger already agree', () => {
    // A correction is logged loudly, so reporting one every ten seconds would
    // bury every real event in the audit log.
    const before = ledgerOf({
      currentStart: window.start,
      currentEnd: window.end,
      source: 'computed',
    });

    const after = reconcileLedger(before, [turn], window.start + HOUR);
    expect(after.corrected).toBe(false);
    expect(after.reason).toBe('');
  });

  it('adopts a window when none was known', () => {
    const after = reconcileLedger(ledgerOf(), [turn], window.start + HOUR);
    expect(after.corrected).toBe(true);
    expect(after.ledger.currentEnd).toBe(window.end);
  });
});

describe('reconcileLedger — the model itself, on tiled history', () => {
  it('re-anchors only after a window has actually expired', () => {
    // Messages inside a running window buy nothing and start nothing. Only the
    // first one after expiry moves the phase.
    const first = T0;
    const w1 = computeWindow(first);
    const inside = [first + HOUR, first + 2 * HOUR, w1.end - MINUTE];
    const afterExpiry = w1.end + 3 * MINUTE;

    const mid = reconcileLedger(ledgerOf(), [first, ...inside], w1.end - HOUR);
    expect(mid.ledger.currentEnd).toBe(w1.end);

    const next = reconcileLedger(mid.ledger, [first, ...inside, afterExpiry], afterExpiry + MINUTE);
    expect(next.ledger.currentStart).toBe(computeWindow(afterExpiry).start);
    expect(next.ledger.currentEnd).toBe(w1.end + WINDOW_MS);
  });
});
