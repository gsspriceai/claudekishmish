import { describe, expect, it } from 'vitest';
import {
  decideClaim,
  idleClaimAllowed,
  recentIdleClaims,
  sessionResumable,
  WEEK_MS,
  type Actor,
} from '../src/window/claimer.js';
import { DEFAULT_CONFIG, type Config } from '../src/config/index.js';
import { emptyState, type LimitEvent, type State, type SupervisedSession } from '../src/state/schema.js';
import { WINDOW_MS } from '../src/window/ledger.js';

const BOUNDARY = Date.UTC(2026, 7, 9, 14, 0, 0);
const NOW = BOUNDARY + 30_000;

const WRAPPER: Actor = { id: 'wrapper-1', ownSessionId: 'sess-1' };
const DAEMON: Actor = { id: 'daemon-1', ownSessionId: null };

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
    sessionStatus: 'idle',
    hasDraftInput: false,
    supervisedFrom: BOUNDARY - 7200_000,
    paused: false,
    pendingResume: true,
    resumeCount: 0,
    limit: sessionLimit(),
    missedLivenessChecks: 0,
    registeredAt: BOUNDARY - 7200_000,
    updatedAt: BOUNDARY,
    ...overrides,
  };
}

function stateWithBoundaryDue(sessions: SupervisedSession[] = [], extra: Partial<State> = {}): State {
  return {
    ...emptyState(NOW),
    ledger: {
      currentStart: BOUNDARY - WINDOW_MS,
      currentEnd: BOUNDARY,
      lastClaimedBoundary: null,
      reservation: null,
      source: 'reset-message',
    },
    sessions: Object.fromEntries(sessions.map((s) => [s.sessionId, s])),
    ...extra,
  };
}

const config: Config = { ...DEFAULT_CONFIG, boundaryBufferMs: 20_000, idleClaim: false };
const withIdle: Config = { ...config, idleClaim: true };

describe('sessionResumable', () => {
  it('accepts a healthy pending session', () => {
    expect(sessionResumable(session(), config, NOW).ok).toBe(true);
  });

  it('refuses a paused session', () => {
    expect(sessionResumable(session({ paused: true }), config, NOW).reason).toMatch(/paused/);
  });

  it('refuses when we do not own the pty', () => {
    expect(sessionResumable(session({ ptyOwned: false }), config, NOW).reason).toMatch(/pty/);
  });

  it('refuses a limit recorded before this supervision run began', () => {
    // Claude Code appends to the same transcript across resumes. A historical
    // rate_limit record must never make us type into a session the user has
    // only just opened.
    const stale = session({
      supervisedFrom: NOW - 60_000,
      limit: sessionLimit({ detectedAt: NOW - 26 * 3600_000, resetAt: NOW - 21 * 3600_000 }),
    });
    const r = sessionResumable(stale, config, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/predates/);
  });

  it('refuses before the stated reset has actually arrived', () => {
    const notYet = session({ limit: sessionLimit({ resetAt: NOW + 3600_000 }) });
    expect(sessionResumable(notYet, config, NOW).reason).toMatch(/not passed/);
  });

  it('refuses a limit whose reset could not be read', () => {
    expect(sessionResumable(session({ limit: sessionLimit({ resetAt: null }) }), config, NOW).ok).toBe(false);
  });

  it('refuses model and weekly limits outright', () => {
    expect(sessionResumable(session({ limit: sessionLimit({ kind: 'model', resetAt: null }) }), config, NOW).reason).toMatch(/model/);
    expect(sessionResumable(session({ limit: sessionLimit({ kind: 'weekly' }) }), config, NOW).reason).toMatch(/weekly/);
  });

  it('enforces the per-session resume cap', () => {
    const capped = session({ resumeCount: config.maxResumesPerSession });
    expect(sessionResumable(capped, config, NOW).reason).toMatch(/cap reached/);
  });
});

describe('idleClaimAllowed', () => {
  it('is on by default', () => {
    expect(idleClaimAllowed(stateWithBoundaryDue(), DEFAULT_CONFIG, NOW).ok).toBe(true);
  });

  it('can be switched off outright', () => {
    expect(idleClaimAllowed(stateWithBoundaryDue(), config, NOW).reason).toMatch(/idle claiming is off/);
  });

  it('is allowed once enabled', () => {
    expect(idleClaimAllowed(stateWithBoundaryDue(), withIdle, NOW).ok).toBe(true);
  });

  it('stays suspended after a weekly limit', () => {
    const state = stateWithBoundaryDue([], { weekly: { suspendedUntil: NOW + 3600_000, idleClaims: [] } });
    expect(idleClaimAllowed(state, withIdle, NOW).reason).toMatch(/weekly limit/);
  });

  it('enforces the weekly idle-claim cap', () => {
    const state = stateWithBoundaryDue([], {
      weekly: { suspendedUntil: null, idleClaims: [NOW - 1, NOW - 2, NOW - 3] },
    });
    expect(idleClaimAllowed(state, { ...withIdle, maxIdleClaimsPerWeek: 3 }, NOW).ok).toBe(false);
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
    expect(decideClaim(stateWithBoundaryDue([session()]), config, BOUNDARY + 5_000, WRAPPER).action).toBe('none');
  });

  it('resumes pending work rather than pinging, for the pty owner', () => {
    const d = decideClaim(stateWithBoundaryDue([session()]), withIdle, NOW, WRAPPER);
    expect(d.action).toBe('resume');
    expect(d).toHaveProperty('sessionId', 'sess-1');
  });

  /**
   * The defect this suite exists for.
   *
   * The daemon owns no PTY. If it decides "resume" it cannot act, and if it
   * consumes the boundary anyway the continuation never happens *and* the
   * ledger reports a window that was never claimed.
   */
  it('DEFERS instead of claiming when the pending session belongs to another process', () => {
    const d = decideClaim(stateWithBoundaryDue([session()]), withIdle, NOW, DAEMON);
    expect(d.action).toBe('defer');
    expect(d).toHaveProperty('sessionId', 'sess-1');
  });

  it('never pings past a session another process is about to continue', () => {
    // Pinging would claim the very window the wrapper needs to resume into.
    const d = decideClaim(stateWithBoundaryDue([session()]), withIdle, NOW, DAEMON);
    expect(d.action).not.toBe('ping');
  });

  it('stops deferring once the grace has expired, so a dead owner cannot strand the boundary', () => {
    const late = BOUNDARY + config.boundaryBufferMs + config.resumeDeferGraceMs + 1;
    expect(decideClaim(stateWithBoundaryDue([session()]), withIdle, late, DAEMON).action).toBe('ping');
  });

  it('pings when there is nothing to resume', () => {
    expect(decideClaim(stateWithBoundaryDue([]), withIdle, NOW, DAEMON).action).toBe('ping');
  });

  it('stands off while another actor holds the boundary', () => {
    const state = stateWithBoundaryDue([]);
    state.ledger.reservation = { boundary: BOUNDARY, owner: 'someone-else', expiresAt: NOW + 60_000 };
    expect(decideClaim(state, withIdle, NOW, DAEMON).reason).toMatch(/already acting/);
  });

  it('picks the longest-waiting session first', () => {
    const older = session({ sessionId: 'old', limit: sessionLimit({ detectedAt: BOUNDARY - 7200_000 }) });
    const newer = session({ sessionId: 'new', limit: sessionLimit({ detectedAt: BOUNDARY - 600_000 }) });
    const actor: Actor = { id: 'w', ownSessionId: 'old' };
    expect(decideClaim(stateWithBoundaryDue([newer, older]), config, NOW, actor)).toHaveProperty('sessionId', 'old');
  });

  it('honours the global pause above everything else', () => {
    const state = stateWithBoundaryDue([session()], { globalPaused: true });
    expect(decideClaim(state, withIdle, NOW, WRAPPER).reason).toMatch(/paused globally/);
  });

  it('does nothing at all once halted', () => {
    // An ended subscription must stop the tool, not make it retry for ever.
    const state = stateWithBoundaryDue([session()], {
      halted: { reason: 'subscription', detectedAt: NOW - 1000, detail: 'subscription has ended' },
    });
    const d = decideClaim(state, withIdle, NOW, WRAPPER);
    expect(d.action).toBe('none');
    expect(d.reason).toMatch(/halted/);
  });

  it('does not resume when auto-continue is switched off', () => {
    const off = { ...config, autoContinue: false, idleClaim: false };
    expect(decideClaim(stateWithBoundaryDue([session()]), off, NOW, WRAPPER).action).toBe('none');
  });

  it('falls through to a ping when the only session is paused', () => {
    expect(decideClaim(stateWithBoundaryDue([session({ paused: true })]), withIdle, NOW, WRAPPER).action).toBe('ping');
  });

  it('does nothing at a boundary that was already claimed', () => {
    const state = stateWithBoundaryDue([]);
    state.ledger.lastClaimedBoundary = BOUNDARY;
    expect(decideClaim(state, withIdle, NOW, DAEMON).action).toBe('none');
  });
});

/**
 * The claim ladder, cheapest first:
 *
 *   1. a session already stopped at the limit  -> continue it
 *   2. a session already open and idle         -> nudge it
 *   3. neither                                 -> start a new session
 *
 * Every rung claims the window. The difference is how much is created to do it,
 * and whether the user's own conversation carries the window afterwards.
 */
describe('claim ladder', () => {
  /** Open and idle, with nothing pending. */
  function idleOpen(overrides: Partial<SupervisedSession> = {}): SupervisedSession {
    return session({
      pendingResume: false,
      limit: null,
      sessionStatus: 'idle',
      hasDraftInput: false,
      ...overrides,
    });
  }

  it('1. continues a limit-stopped session rather than nudging or starting one', () => {
    const d = decideClaim(stateWithBoundaryDue([session()]), withIdle, NOW, WRAPPER);
    expect(d.action).toBe('resume');
  });

  it('2. nudges an already-open idle session rather than starting a new one', () => {
    const d = decideClaim(stateWithBoundaryDue([idleOpen()]), withIdle, NOW, WRAPPER);
    expect(d.action).toBe('nudge');
    expect(d).toHaveProperty('sessionId', 'sess-1');
  });

  it('3. starts a new session only when there is nothing open at all', () => {
    expect(decideClaim(stateWithBoundaryDue([]), withIdle, NOW, WRAPPER).action).toBe('ping');
  });

  it('will not nudge a session that is busy', () => {
    // Claude is mid-turn; the window is being claimed by that work anyway.
    const d = decideClaim(stateWithBoundaryDue([idleOpen({ sessionStatus: 'busy' })]), withIdle, NOW, WRAPPER);
    expect(d.action).toBe('ping');
  });

  it('will not nudge a session sitting in a subshell', () => {
    // Our text would land in the shell, not in Claude.
    const d = decideClaim(stateWithBoundaryDue([idleOpen({ sessionStatus: 'shell' })]), withIdle, NOW, WRAPPER);
    expect(d.action).toBe('ping');
  });

  it('will not nudge when the user has something typed but not sent', () => {
    // Injecting would append to their draft and press Enter for them.
    const d = decideClaim(stateWithBoundaryDue([idleOpen({ hasDraftInput: true })]), withIdle, NOW, WRAPPER);
    expect(d.action).toBe('ping');
  });

  it('will not nudge a paused session', () => {
    const d = decideClaim(stateWithBoundaryDue([idleOpen({ paused: true })]), withIdle, NOW, WRAPPER);
    expect(d.action).toBe('ping');
  });

  it('will not nudge a session we do not own the pty for', () => {
    const d = decideClaim(stateWithBoundaryDue([idleOpen({ ptyOwned: false })]), withIdle, NOW, WRAPPER);
    expect(d.action).toBe('ping');
  });

  it('will not nudge a session still inside an uncleared limit', () => {
    const stuck = idleOpen({ limit: sessionLimit({ resetAt: NOW + 3600_000 }) });
    expect(decideClaim(stateWithBoundaryDue([stuck]), withIdle, NOW, WRAPPER).action).toBe('ping');
  });

  it('defers to the process that owns an open session, rather than starting one', () => {
    // The daemon cannot type into someone else's terminal, and spawning a
    // session when one is sitting right there is the thing to avoid.
    const d = decideClaim(stateWithBoundaryDue([idleOpen()]), withIdle, NOW, DAEMON);
    expect(d.action).toBe('defer');
  });

  it('falls back to starting a session if that process never acts', () => {
    const late = BOUNDARY + config.boundaryBufferMs + config.resumeDeferGraceMs + 1;
    expect(decideClaim(stateWithBoundaryDue([idleOpen()]), withIdle, late, DAEMON).action).toBe('ping');
  });

  it('nudging is still bounded by the weekly cap', () => {
    const state = stateWithBoundaryDue([idleOpen()], {
      weekly: { suspendedUntil: null, idleClaims: Array.from({ length: 14 }, () => NOW - 1000) },
    });
    expect(decideClaim(state, withIdle, NOW, WRAPPER).action).toBe('none');
  });
});
