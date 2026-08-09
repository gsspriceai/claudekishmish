import { describe, expect, it } from 'vitest';
import {
  applyObservation,
  ceil10,
  computeWindow,
  floor10,
  GRID_MS,
  isBoundaryDue,
  isExpired,
  msUntilBoundary,
  nextBoundary,
  recordClaim,
  WINDOW_MS,
} from '../src/window/ledger.js';
import type { WindowLedger } from '../src/state/schema.js';

const EMPTY: WindowLedger = {
  currentStart: null,
  currentEnd: null,
  lastClaimedBoundary: null,
  source: null,
};

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

  it('ceil10 rounds up off-grid times', () => {
    const base = Date.UTC(2026, 7, 9, 14, 0, 0);
    expect(ceil10(base + 1)).toBe(base + GRID_MS);
  });
});

describe('computeWindow', () => {
  /**
   * The cases below are the real ones: first-turn timestamps taken from
   * transcripts, checked against the reset the server actually stated.
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
      const { end } = computeWindow(first);
      const got = new Date(end);
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
  it('fills an empty ledger', () => {
    const end = Date.UTC(2026, 7, 9, 14, 0);
    const next = applyObservation(EMPTY, { end, source: 'computed' });
    expect(next.currentEnd).toBe(end);
    expect(next.currentStart).toBe(end - WINDOW_MS);
  });

  it('lets a server-stated reset override our own arithmetic', () => {
    const computed = applyObservation(EMPTY, {
      end: Date.UTC(2026, 7, 9, 14, 0),
      source: 'computed',
    });
    const stated = applyObservation(computed, {
      end: Date.UTC(2026, 7, 9, 13, 30),
      source: 'reset-message',
    });
    expect(stated.currentEnd).toBe(Date.UTC(2026, 7, 9, 13, 30));
    expect(stated.source).toBe('reset-message');
  });

  it('refuses to let arithmetic overwrite a server-stated reset', () => {
    const stated = applyObservation(EMPTY, {
      end: Date.UTC(2026, 7, 9, 13, 30),
      source: 'reset-message',
    });
    const attempted = applyObservation(stated, {
      end: Date.UTC(2026, 7, 9, 18, 0),
      source: 'computed',
    });
    expect(attempted.currentEnd).toBe(Date.UTC(2026, 7, 9, 13, 30));
  });

  it('never walks the ledger backwards on a stale read', () => {
    const later = applyObservation(EMPTY, {
      end: Date.UTC(2026, 7, 9, 18, 0),
      source: 'computed',
    });
    const stale = applyObservation(later, {
      end: Date.UTC(2026, 7, 9, 12, 0),
      source: 'computed',
    });
    expect(stale.currentEnd).toBe(Date.UTC(2026, 7, 9, 18, 0));
  });
});

describe('boundaries', () => {
  const end = Date.UTC(2026, 7, 9, 14, 0);
  const ledger: WindowLedger = {
    currentStart: end - WINDOW_MS,
    currentEnd: end,
    lastClaimedBoundary: null,
    source: 'computed',
  };

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

  it('counts down correctly', () => {
    expect(msUntilBoundary(ledger, end - 60_000, 0)).toBe(60_000);
    expect(msUntilBoundary(ledger, end + 5, 0)).toBe(0);
    expect(msUntilBoundary(EMPTY, Date.now(), 0)).toBeNull();
  });

  it('treats an already-claimed boundary as spent', () => {
    const claimed: WindowLedger = { ...ledger, lastClaimedBoundary: end };
    expect(nextBoundary(claimed)).toBeNull();
    expect(isBoundaryDue(claimed, end + 60_000, 20_000)).toBe(false);
  });

  it('knows when a window has expired', () => {
    expect(isExpired(ledger, end - 1)).toBe(false);
    expect(isExpired(ledger, end)).toBe(true);
    expect(isExpired(EMPTY, Date.now())).toBe(false);
  });
});

describe('recordClaim', () => {
  it('opens a new window anchored at the claim, and marks the old boundary spent', () => {
    const end = Date.UTC(2026, 7, 9, 14, 0);
    const ledger: WindowLedger = {
      currentStart: end - WINDOW_MS,
      currentEnd: end,
      lastClaimedBoundary: null,
      source: 'computed',
    };
    // Claim fires 25 seconds after the boundary, as the buffer intends.
    const claimedAt = end + 25_000;
    const next = recordClaim(ledger, claimedAt);

    expect(next.lastClaimedBoundary).toBe(end);
    expect(next.currentStart).toBe(floor10(claimedAt));
    expect(next.currentEnd).toBe(floor10(claimedAt) + WINDOW_MS);
    // The claim is a first message, so the new window is anchored on the grid.
    expect(next.currentStart! % GRID_MS).toBe(0);
  });

  it('makes the same boundary un-claimable a second time', () => {
    const end = Date.UTC(2026, 7, 9, 14, 0);
    const ledger: WindowLedger = {
      currentStart: end - WINDOW_MS,
      currentEnd: end,
      lastClaimedBoundary: null,
      source: 'computed',
    };
    const after = recordClaim(ledger, end + 25_000);
    expect(isBoundaryDue(after, end + 30_000, 20_000)).toBe(false);
  });
});
