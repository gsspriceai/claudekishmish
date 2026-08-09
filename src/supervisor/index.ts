/**
 * The supervision loop shared by `ckm wrap` and `ckm daemon`.
 *
 * Both roles do the same three things on every tick: refresh what we know about
 * the current window, notice limit interruptions, and act if a boundary is due.
 * They differ only in what they are allowed to do about it — a wrapper owns a
 * PTY and can continue a session in place; the daemon can only claim an
 * otherwise-idle boundary.
 *
 * Decisions are made inside the state lock and executed outside it, so a slow
 * spawn never blocks another process from reading state.
 */

import { loadConfig, type Config } from '../config/index.js';
import { logAction, logInfo, logWarn } from '../logger/index.js';
import { mutateState, readState, updateState } from '../state/store.js';
import type { LimitEvent, State, SupervisedSession } from '../state/schema.js';
import { decideClaim, sessionResumable, type ClaimDecision } from '../window/claimer.js';
import { applyObservation, computeWindow, recordClaim, WINDOW_MS } from '../window/ledger.js';
import { sendPingWithRetry } from '../window/ping.js';
import { findTranscript, latestLimitEvent, readSince, userTurnTimes } from '../claude/transcript.js';
import { sessionStillRunning } from '../claude/sessions.js';

/** Fold a limit event into the ledger and the session record. */
export function absorbLimit(state: State, sessionId: string | null, event: LimitEvent): State {
  const next: State = { ...state, sessions: { ...state.sessions } };

  if (event.kind === 'weekly' && event.resetAt !== null) {
    // Idle claims stay suspended until the weekly cap actually clears; otherwise
    // the tool would spend the very budget it exists to protect.
    next.weekly = { ...next.weekly, suspendedUntil: event.resetAt };
  }

  if (event.resetAt !== null && event.kind === 'session') {
    next.ledger = applyObservation(next.ledger, {
      end: event.resetAt,
      start: event.resetAt - WINDOW_MS,
      source: 'reset-message',
    });
  }

  if (sessionId && next.sessions[sessionId]) {
    const session = next.sessions[sessionId]!;
    next.sessions[sessionId] = {
      ...session,
      limit: event,
      // Only a session limit is worth waiting for. A weekly cap is days away and
      // a model cap never clears by waiting.
      pendingResume: event.kind === 'session' && event.resetAt !== null,
      updatedAt: Date.now(),
    };
  }

  return next;
}

/** Keep the ledger current from ordinary conversation activity. */
export function absorbTurns(state: State, turns: number[]): State {
  const last = turns[turns.length - 1];
  if (last === undefined) return state;

  const known = state.ledger.currentEnd;
  // A turn beyond the known window means a new window was anchored by it.
  if (known === null || last >= known) {
    const { start, end } = computeWindow(last);
    return { ...state, ledger: applyObservation(state.ledger, { start, end, source: 'computed' }) };
  }
  return state;
}

export interface TickContext {
  /** Non-null in a wrapper: the one session this process may continue. */
  ownSessionId: string | null;
  /** Perform the in-place continuation. Wrapper-only. */
  resume: (sessionId: string) => Promise<boolean>;
  config: Config;
}

/**
 * One supervision tick.
 *
 * Returns the decision that was taken, which the CLI surfaces and the tests
 * assert against.
 */
export async function tick(ctx: TickContext): Promise<ClaimDecision> {
  const now = Date.now();

  const decision = updateState((state) => {
    let next = pruneDeadSessions(state);
    next = refreshFromTranscripts(next, ctx.ownSessionId);
    const d = decideClaim(next, ctx.config, now);

    // Reserve the boundary inside the lock so the daemon and a wrapper cannot
    // both act on it. Anything that fails afterwards is logged, not retried
    // blindly — a double claim costs more than a missed one.
    if (d.action !== 'none') {
      next = { ...next, ledger: recordClaim(next.ledger, now) };
    }
    return { next, result: d };
  });

  if (decision.action === 'none') return decision;

  logAction('boundary.claim', { action: decision.action, reason: decision.reason });

  if (decision.action === 'resume') {
    if (ctx.ownSessionId !== decision.sessionId) {
      // Another process owns that PTY; it will handle it on its own tick.
      logInfo('resume.delegated', { sessionId: decision.sessionId });
      return decision;
    }
    const ok = await ctx.resume(decision.sessionId);
    mutateState((s) => {
      const session = s.sessions[decision.sessionId];
      if (!session) return s;
      return {
        ...s,
        sessions: {
          ...s.sessions,
          [decision.sessionId]: {
            ...session,
            pendingResume: false,
            resumeCount: session.resumeCount + (ok ? 1 : 0),
            updatedAt: Date.now(),
          },
        },
      };
    });
    logAction(ok ? 'resume.ok' : 'resume.failed', { sessionId: decision.sessionId });
    return decision;
  }

  const result = await sendPingWithRetry(ctx.config.pingText);
  mutateState((s) => ({
    ...s,
    weekly: {
      ...s.weekly,
      idleClaims: result.ok ? [...s.weekly.idleClaims, Date.now()] : s.weekly.idleClaims,
    },
  }));
  if (!result.ok) logWarn('ping.gave_up', { detail: result.detail });
  return decision;
}

/** Drop sessions whose process is gone, or whose PID was reused. */
export function pruneDeadSessions(state: State): State {
  const sessions: Record<string, SupervisedSession> = {};
  for (const [id, session] of Object.entries(state.sessions)) {
    if (sessionStillRunning(id, session.procStart)) sessions[id] = session;
  }
  return { ...state, sessions };
}

/** Read new transcript lines for supervised sessions and fold them in. */
function refreshFromTranscripts(state: State, ownSessionId: string | null): State {
  let next = state;
  const ids = ownSessionId ? [ownSessionId] : Object.keys(state.sessions);

  for (const id of ids) {
    const file = findTranscript(id);
    if (!file) continue;
    const { records } = readSince(file, 0);
    if (records.length === 0) continue;

    next = absorbTurns(next, userTurnTimes(records));

    const event = latestLimitEvent(records);
    if (event) {
      const existing = next.sessions[id]?.limit;
      if (!existing || existing.detectedAt !== event.detectedAt) {
        next = absorbLimit(next, id, event);
      }
    }
  }
  return next;
}

/** Register a wrapped session so the daemon and `ckm status` can see it. */
export function registerSession(session: Omit<SupervisedSession, 'registeredAt' | 'updatedAt'>): void {
  const now = Date.now();
  mutateState((state) => ({
    ...state,
    sessions: {
      ...state.sessions,
      [session.sessionId]: { ...session, registeredAt: now, updatedAt: now },
    },
  }));
  logInfo('session.registered', { sessionId: session.sessionId, name: session.name });
}

export function deregisterSession(sessionId: string): void {
  mutateState((state) => {
    const sessions = { ...state.sessions };
    delete sessions[sessionId];
    return { ...state, sessions };
  });
  logInfo('session.deregistered', { sessionId });
}

/** Re-check eligibility at the moment of acting, not at the moment of planning. */
export function stillEligible(sessionId: string, config = loadConfig()): boolean {
  const state = readState();
  if (state.globalPaused) return false;
  const session = state.sessions[sessionId];
  if (!session) return false;
  return sessionResumable(session, config, Date.now()).ok;
}
