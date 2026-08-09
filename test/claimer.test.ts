import { describe, expect, it } from 'vitest';
import { decideClaim, idleClaimAllowed, recentIdleClaims, sessionResumable, WEEK_MS } from '../src/window/claimer.js';
import { DEFAULT_CONFIG, type Config } from '../src/config/index.js';
import { emptyState, type LimitEvent, type State, type SupervisedSession } from '../src/state/schema.js';
import { WINDOW_MS } from '../src/window/ledger.js';

const NOW = Date.UTC(2026, 7, 9, 14, 0, 30);
const BOUNDARY = Date.UTC(2026, 7, 9, 14, 0, 0);

function sessionLimit(overrides: Partial<LimitEvent> = {}): LimitEvent {
  return {
    kind: 'session',
    detectedAt: BOUNDARY - 3600_000,
    resetAt: BOUNDARY,
    raw: "You've hit your session limit · resets 2pm (Asia/Calcutta)",
    ...overrides,
  };
}

function session(overrides: Partial<SupervisedSession> = {}): SupervisedSession {
  return {
    sessionId: 'sess-1',
    pid: 1234,
    procStart: 'abc',
    cwd: '/repo',
    name: 'repo-1',
    ptyOwned: true,
    paused: false,
    pendingResume: true,
    resumeCount: 0,
    limit: sessionLimit(),
    registeredAt: BOUNDARY - 7200_000,
    updatedAt: BOUNDARY,
    ...overrides,
  };
}

function stateWithBoundaryDue(sessions: SupervisedSession[] = [], extra: Partial<State> = {}): State {
  const base = emptyState(NOW);
  return {
    ...base,
    ledger: {
      currentStart: BOUNDARY - WINDOW_MS,
      currentEnd: BOUNDARY,
      lastClaimedBoundary: null,
      source: 'reset-message',
    },
    sessions: Object.fromEntries(sessions.map((s) => [s.sessionId, s])),
    ...extra,
  };
}

const config: Config = { ...DEFAULT_CONFIG, boundaryBufferMs: 20_000 };

describe('sessionResumable', () => {
  it('accepts a healthy pending session', () => {
    expect(sessionResumable(session(), config, NOW).ok).toBe(true);
  });

  it('refuses a paused session', () => {
    const r = sessionResumable(session({ paused: true }), config, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/paused/);
  });

  it('refuses when nothing is pending', () => {
    expect(sessionResumable(session({ pendingResume: false }), config, NOW).ok).toBe(false);
  });

  it('refuses when we do not own the pty', () => {
    const r = sessionResumable(session({ ptyOwned: false }), config, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/pty/);
  });

  it('refuses a model limit outright', () => {
    const r = sessionResumable(
      session({ limit: sessionLimit({ kind: 'model', resetAt: null }) }),
      config,
      NOW,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/model limit/);
  });

  it('refuses a weekly limit until its reset has passed', () => {
    const weekly = sessionLimit({ kind: 'weekly', resetAt: NOW + 2 * 24 * 3600_000 });
    expect(sessionResumable(session({ limit: weekly }), config, NOW).ok).toBe(false);

    const cleared = sessionLimit({ kind: 'weekly', resetAt: NOW - 1000 });
    expect(sessionResumable(session({ limit: cleared }), config, NOW).ok).toBe(true);
  });

  it('enforces the per-session resume cap', () => {
    const capped = session({ resumeCount: config.maxResumesPerSession });
    const r = sessionResumable(capped, config, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cap reached/);
  });
});

describe('idleClaimAllowed', () => {
  it('is off unless explicitly enabled', () => {
    const r = idleClaimAllowed(stateWithBoundaryDue(), config, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/idle claiming is off/);
  });

  it('is allowed once enabled', () => {
    const on = { ...config, idleClaim: true };
    expect(idleClaimAllowed(stateWithBoundaryDue(), on, NOW).ok).toBe(true);
  });

  it('stays suspended after a weekly limit', () => {
    const on = { ...config, idleClaim: true };
    const state = stateWithBoundaryDue([], {
      weekly: { suspendedUntil: NOW + 3600_000, idleClaims: [] },
    });
    const r = idleClaimAllowed(state, on, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/weekly limit/);
  });

  it('enforces the weekly idle-claim cap', () => {
    const on = { ...config, idleClaim: true, maxIdleClaimsPerWeek: 3 };
    const state = stateWithBoundaryDue([], {
      weekly: { suspendedUntil: null, idleClaims: [NOW - 1000, NOW - 2000, NOW - 3000] },
    });
    expect(idleClaimAllowed(state, on, NOW).ok).toBe(false);
  });

  it('forgets claims older than seven days', () => {
    const state = stateWithBoundaryDue([], {
      weekly: { suspendedUntil: null, idleClaims: [NOW - WEEK_MS - 1000, NOW - 1000] },
    });
    expect(recentIdleClaims(state, NOW)).toEqual([NOW - 1000]);
  });
});

describe('decideClaim', () => {
  it('does nothing before the boundary buffer elapses', () => {
    const d = decideClaim(stateWithBoundaryDue([session()]), config, BOUNDARY + 5_000);
    expect(d.action).toBe('none');
    expect(d.reason).toMatch(/not due/);
  });

  it('resumes pending work rather than pinging', () => {
    const on = { ...config, idleClaim: true };
    const d = decideClaim(stateWithBoundaryDue([session()]), on, NOW);
    expect(d.action).toBe('resume');
    expect(d).toHaveProperty('sessionId', 'sess-1');
  });

  it('pings only when there is nothing to resume', () => {
    const on = { ...config, idleClaim: true };
    const d = decideClaim(stateWithBoundaryDue([]), on, NOW);
    expect(d.action).toBe('ping');
  });

  it('picks the longest-waiting session first', () => {
    const older = session({
      sessionId: 'old',
      limit: sessionLimit({ detectedAt: BOUNDARY - 7200_000 }),
    });
    const newer = session({
      sessionId: 'new',
      limit: sessionLimit({ detectedAt: BOUNDARY - 600_000 }),
    });
    const d = decideClaim(stateWithBoundaryDue([newer, older]), config, NOW);
    expect(d).toHaveProperty('sessionId', 'old');
  });

  it('honours the global pause above everything else', () => {
    const on = { ...config, idleClaim: true };
    const state = stateWithBoundaryDue([session()], { globalPaused: true });
    const d = decideClaim(state, on, NOW);
    expect(d.action).toBe('none');
    expect(d.reason).toMatch(/paused globally/);
  });

  it('does not resume when auto-continue is switched off', () => {
    const off = { ...config, autoContinue: false, idleClaim: false };
    const d = decideClaim(stateWithBoundaryDue([session()]), off, NOW);
    expect(d.action).toBe('none');
  });

  it('falls through to a ping when the only session is paused', () => {
    const on = { ...config, idleClaim: true };
    const d = decideClaim(stateWithBoundaryDue([session({ paused: true })]), on, NOW);
    expect(d.action).toBe('ping');
  });

  it('does nothing at a boundary that was already claimed', () => {
    const on = { ...config, idleClaim: true };
    const state = stateWithBoundaryDue([]);
    state.ledger.lastClaimedBoundary = BOUNDARY;
    expect(decideClaim(state, on, NOW).action).toBe('none');
  });
});
