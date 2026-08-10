import { describe, expect, it } from 'vitest';
import {
  applyObservation,
  ceil10,
  commitClaim,
  holdsReservation,
  computeWindow,
  deriveLedgerFromTurns,
  floor10,
  GRID_MS,
  isBoundaryDue,
  isExpired,
  msUntilBoundary,
  nextBoundary,
  releaseReservation,
  repairLedger,
  reserveBoundary,
  reservedByOther,
  RESERVATION_TTL_MS,
  WINDOW_MS,
} from '../src/window/ledger.js';
import type { WindowLedger } from '../src/state/schema.js';

const EMPTY: WindowLedger = {
  currentStart: null,
  currentEnd: null,
  lastClaimedBoundary: null,
  reservation: null,
  source: null,
};

function ledgerEnding(end: number, source: WindowLedger['source'] = 'computed'): WindowLedger {
  return { currentStart: end - WINDOW_MS, currentEnd: end, lastClaimedBoundary: null, reservation: null, source };
}

describe('floor10 / ceil10', () => {
  it('snaps to the 10-minute grid', () => {
    const base = Date.UTC(2026, 7, 9, 14, 0, 0);
    expect(floor10(base + 7 * 60_000)).toBe(base);
    expect(floor10(base + 9 * 60_000 + 59_000)).toBe(base);
    expect(floor10(base + 10 * 60_000)).toBe(base + GRID_MS);
  });

  it('leaves an on-grid time alone', () => {
    const base = Date.UTC(2026, 7, 9, 14, 20, 0);
    expect(floor10(base)).toBe(base);
    expect(ceil10(base)).toBe(base);
  });
});

describe('computeWindow', () => {
  /**
   * Real cases: first-turn timestamps from transcripts, checked against the
   * reset the server actually stated.
   */
  const REAL_CASES = [
    { firstTurn: [18, 32], expectedEnd: [23, 30] },
    { firstTurn: [15, 29], expectedEnd: [20, 20] },
    { firstTurn: [6, 57], expectedEnd: [11, 50] },
    { firstTurn: [9, 8], expectedEnd: [14, 0] },
    { firstTurn: [14, 53], expectedEnd: [19, 50] },
    { firstTurn: [13, 32], expectedEnd: [18, 30] },
    { firstTurn: [3, 23], expectedEnd: [8, 20] },
    { firstTurn: [9, 52], expectedEnd: [14, 50] },
    { firstTurn: [7, 54], expectedEnd: [12, 50] },
  ] as const;

  it('reproduces every verified real window', () => {
    for (const c of REAL_CASES) {
      const first = Date.UTC(2026, 7, 9, c.firstTurn[0], c.firstTurn[1], 0);
      const got = new Date(computeWindow(first).end);
      const label = `${c.firstTurn[0]}:${c.firstTurn[1]}`;
      expect(got.getUTCHours(), label).toBe(c.expectedEnd[0]);
      expect(got.getUTCMinutes(), label).toBe(c.expectedEnd[1]);
    }
  });

  it('produces a window exactly five hours long', () => {
    const { start, end } = computeWindow(Date.UTC(2026, 7, 9, 9, 8, 0));
    expect(end - start).toBe(WINDOW_MS);
  });
});

describe('applyObservation', () => {
  const now = Date.UTC(2026, 7, 9, 10, 0);

  it('fills an empty ledger', () => {
    const end = Date.UTC(2026, 7, 9, 14, 0);
    const next = applyObservation(EMPTY, { end, source: 'computed' }, now);
    expect(next.currentEnd).toBe(end);
    expect(next.currentStart).toBe(end - WINDOW_MS);
  });

  it('lets a server-stated reset override our own arithmetic', () => {
    const computed = applyObservation(EMPTY, { end: Date.UTC(2026, 7, 9, 14, 0), source: 'computed' }, now);
    const stated = applyObservation(computed, { end: Date.UTC(2026, 7, 9, 13, 30), source: 'reset-message' }, now);
    expect(stated.currentEnd).toBe(Date.UTC(2026, 7, 9, 13, 30));
    expect(stated.source).toBe('reset-message');
  });

  it('refuses to let arithmetic overwrite a reset that has not happened yet', () => {
    const stated = applyObservation(EMPTY, { end: Date.UTC(2026, 7, 9, 13, 30), source: 'reset-message' }, now);
    const attempted = applyObservation(stated, { end: Date.UTC(2026, 7, 9, 18, 0), source: 'computed' }, now);
    expect(attempted.currentEnd).toBe(Date.UTC(2026, 7, 9, 13, 30));
  });

  it('releases that authority once the stated reset has passed', () => {
    // Without an expiry the ledger freezes on the first limit it ever sees:
    // every later turn is rejected and `nextBoundary` stays permanently in the
    // past, so every tick evaluates against a boundary that already happened.
    const statedEnd = Date.UTC(2026, 7, 9, 13, 30);
    const stated = applyObservation(EMPTY, { end: statedEnd, source: 'reset-message' }, now);

    const later = statedEnd + 3 * 24 * 3600_000;
    const healed = applyObservation(stated, { end: later + WINDOW_MS, source: 'computed' }, later);

    expect(healed.currentEnd).toBe(later + WINDOW_MS);
    expect(healed.source).toBe('computed');
  });

  it('never walks the ledger backwards on a stale read', () => {
    const later = applyObservation(EMPTY, { end: Date.UTC(2026, 7, 9, 18, 0), source: 'computed' }, now);
    const stale = applyObservation(later, { end: Date.UTC(2026, 7, 9, 12, 0), source: 'computed' }, now);
    expect(stale.currentEnd).toBe(Date.UTC(2026, 7, 9, 18, 0));
  });
});

describe('boundaries', () => {
  const end = Date.UTC(2026, 7, 9, 14, 0);
  const ledger = ledgerEnding(end);

  it('reports the current end as the next boundary', () => {
    expect(nextBoundary(ledger)).toBe(end);
  });

  it('is not due before the boundary plus buffer', () => {
    expect(isBoundaryDue(ledger, end - 1, 20_000)).toBe(false);
    expect(isBoundaryDue(ledger, end + 10_000, 20_000)).toBe(false);
  });

  it('is due once the buffer has elapsed', () => {
    expect(isBoundaryDue(ledger, end + 20_000, 20_000)).toBe(true);
  });

  it('clamps a negative buffer instead of firing before the window ends', () => {
    // A hand-edited config could otherwise make a boundary "due" an hour early,
    // guaranteeing a request that fails.
    expect(isBoundaryDue(ledger, end - 3600_000, -3600_000)).toBe(false);
  });

  it('treats an already-claimed boundary as spent', () => {
    const claimed: WindowLedger = { ...ledger, lastClaimedBoundary: end };
    expect(nextBoundary(claimed)).toBeNull();
    expect(isBoundaryDue(claimed, end + 60_000, 20_000)).toBe(false);
  });

  it('counts down correctly', () => {
    expect(msUntilBoundary(ledger, end - 60_000, 0)).toBe(60_000);
    expect(msUntilBoundary(EMPTY, Date.now(), 0)).toBeNull();
  });

  it('knows when a window has expired', () => {
    expect(isExpired(ledger, end - 1)).toBe(false);
    expect(isExpired(ledger, end)).toBe(true);
  });
});

describe('reservation protocol', () => {
  const end = Date.UTC(2026, 7, 9, 14, 0);
  const now = end + 25_000;

  it('reserves for an owner without consuming the boundary', () => {
    const reserved = reserveBoundary(ledgerEnding(end), 'actor-a', now);
    expect(reserved.reservation).toMatchObject({ boundary: end, owner: 'actor-a' });
    // Crucially: nothing has been claimed yet.
    expect(reserved.lastClaimedBoundary).toBeNull();
    expect(reserved.currentEnd).toBe(end);
  });

  it('blocks a different actor while the hold is live', () => {
    const reserved = reserveBoundary(ledgerEnding(end), 'actor-a', now);
    expect(reservedByOther(reserved, 'actor-b', now)).toBe(true);
    expect(reservedByOther(reserved, 'actor-a', now)).toBe(false);
  });

  it('lets the boundary be picked up again once the hold expires', () => {
    // Covers the owner dying mid-attempt.
    const reserved = reserveBoundary(ledgerEnding(end), 'actor-a', now);
    expect(reservedByOther(reserved, 'actor-b', now + RESERVATION_TTL_MS + 1)).toBe(false);
  });

  it('releases back to unclaimed, so the boundary survives a failure', () => {
    const reserved = reserveBoundary(ledgerEnding(end), 'actor-a', now);
    const released = releaseReservation(reserved, 'actor-a');
    expect(released.reservation).toBeNull();
    expect(released.lastClaimedBoundary).toBeNull();
    // Still claimable — a failed attempt must not burn the window.
    expect(isBoundaryDue(released, now, 20_000)).toBe(true);
  });

  it('ignores a release from someone who does not hold it', () => {
    const reserved = reserveBoundary(ledgerEnding(end), 'actor-a', now);
    expect(releaseReservation(reserved, 'actor-b').reservation).not.toBeNull();
  });

  it('commits only after a request landed, opening a grid-aligned window', () => {
    const reserved = reserveBoundary(ledgerEnding(end), 'actor-a', now);
    const { ledger: claimed, committed } = commitClaim(reserved, 'actor-a', now);

    expect(committed).toBe(true);
    expect(claimed.lastClaimedBoundary).toBe(end);
    expect(claimed.reservation).toBeNull();
    expect(claimed.currentStart).toBe(floor10(now));
    expect(claimed.currentEnd).toBe(floor10(now) + WINDOW_MS);
    expect(claimed.currentStart! % GRID_MS).toBe(0);
    // And the same boundary can never be claimed twice.
    expect(isBoundaryDue(claimed, now + 1000, 20_000)).toBe(false);
  });

  it('refuses to commit without holding the reservation', () => {
    const reserved = reserveBoundary(ledgerEnding(end), 'actor-a', now);
    const { ledger, committed } = commitClaim(reserved, 'actor-b', now);
    expect(committed).toBe(false);
    expect(ledger).toBe(reserved);
  });

  it('refuses to commit once its own hold has expired', () => {
    // The act phase outliving its reservation is what let two actors claim the
    // same boundary, and the second commit froze the ledger for ever.
    const reserved = reserveBoundary(ledgerEnding(end), 'actor-a', now);
    const late = now + RESERVATION_TTL_MS + 1;
    expect(commitClaim(reserved, 'actor-a', late).committed).toBe(false);
  });

  it('holdsReservation tracks owner and expiry', () => {
    const reserved = reserveBoundary(ledgerEnding(end), 'actor-a', now);
    expect(holdsReservation(reserved, 'actor-a', now)).toBe(true);
    expect(holdsReservation(reserved, 'actor-b', now)).toBe(false);
    expect(holdsReservation(reserved, 'actor-a', now + RESERVATION_TTL_MS + 1)).toBe(false);
  });

  it('the reservation outlives the worst-case act phase', () => {
    // 3 ping attempts of 60s plus 15s and 30s of backoff. If the hold expires
    // first, its owner's own request races a second actor's.
    const worstCaseActPhaseMs = 3 * 60_000 + 15_000 + 30_000;
    expect(RESERVATION_TTL_MS).toBeGreaterThan(worstCaseActPhaseMs);
  });

  /**
   * A claim opens a window five hours past the boundary it spends, so a claim
   * stamp at or after `currentEnd` is impossible. When it happened,
   * `nextBoundary` returned null for ever: the tool went silent while status
   * still showed a healthy window.
   */
  it('never records a claim at or after the window it opens', () => {
    const reserved = reserveBoundary(ledgerEnding(end), 'actor-a', now);
    const { ledger } = commitClaim(reserved, 'actor-a', now);
    expect(ledger.lastClaimedBoundary!).toBeLessThan(ledger.currentEnd!);
  });

  it('repairs an impossible ledger instead of staying frozen for ever', () => {
    const frozen: WindowLedger = {
      currentStart: end,
      currentEnd: end + WINDOW_MS,
      lastClaimedBoundary: end + WINDOW_MS, // at the window's own end
      reservation: null,
      source: 'claim',
    };
    expect(nextBoundary(frozen)).toBeNull();

    const repaired = repairLedger(frozen);
    expect(repaired.lastClaimedBoundary).toBeNull();
    expect(nextBoundary(repaired)).toBe(end + WINDOW_MS);
  });

  it('leaves a healthy ledger alone', () => {
    const healthy = reserveBoundary(ledgerEnding(end), 'a', now);
    const { ledger } = commitClaim(healthy, 'a', now);
    expect(repairLedger(ledger)).toEqual(ledger);
  });
});

describe('deriveLedgerFromTurns', () => {
  it('returns null with no history', () => {
    expect(deriveLedgerFromTurns([])).toBeNull();
  });

  it('tiles windows greedily and reports the most recent', () => {
    const t0 = Date.UTC(2026, 7, 9, 9, 8);
    const turns = [t0, t0 + 60_000, t0 + WINDOW_MS + 60_000];
    const derived = deriveLedgerFromTurns(turns)!;
    expect(derived.start).toBe(floor10(t0 + WINDOW_MS + 60_000));
    expect(derived.end - derived.start).toBe(WINDOW_MS);
  });

  it('keeps turns inside one window in that window', () => {
    const t0 = Date.UTC(2026, 7, 9, 9, 8);
    const derived = deriveLedgerFromTurns([t0, t0 + 3600_000])!;
    expect(derived.start).toBe(floor10(t0));
  });
});
