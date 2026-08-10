/**
 * The supervision loop shared by `ckm wrap` and `ckm daemon`.
 *
 * Each tick has three strictly separated phases:
 *
 *   1. **Observe** — read transcripts and session descriptors. Outside the lock,
 *      because this is the slow part (a real transcript reaches tens of
 *      megabytes) and holding a global lock across it makes every other process
 *      wait, including a wrapper that is pumping a live terminal.
 *   2. **Decide** — inside the lock, synchronous and short. Folds the
 *      observations in, picks an action, and takes an owned, expiring
 *      *reservation* on the boundary. Reserving is not claiming.
 *   3. **Act** — outside the lock. On success the reservation becomes a claim;
 *      on failure or deferral it is released, so a boundary is never consumed by
 *      an actor that did not send a request.
 */

import { randomUUID } from 'node:crypto';
import { loadConfig, type Config } from '../config/index.js';
import { logAction, logError, logInfo, logWarn } from '../logger/index.js';
import { mutateState, readState, updateState } from '../state/store.js';
import type { LimitEvent, State, SupervisedSession } from '../state/schema.js';
import { decideClaim, sessionResumable, WEEK_MS, type Actor, type ClaimDecision } from '../window/claimer.js';
import {
  applyObservation,
  commitClaim,
  computeWindow,
  deriveLedgerFromTurns,
  releaseReservation,
  repairLedger,
  reserveBoundary,
  WINDOW_MS,
} from '../window/ledger.js';
import { sendPingWithRetry } from '../window/ping.js';
import {
  allUserTurnTimes,
  findTranscript,
  latestLimitEvent,
  readSince,
  userTurnTimes,
} from '../claude/transcript.js';
import { checkSessionLiveness, readSessionFiles, type LivenessResult } from '../claude/sessions.js';

/** How many consecutive unreadable liveness checks before we give up on a session. */
const MAX_MISSED_LIVENESS = 5;

/** This process's identity, used to own boundary reservations. */
export const ACTOR_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

/** Per-session transcript read offsets, so a tick never re-reads the whole file. */
const readOffsets = new Map<string, number>();

interface SessionObservation {
  sessionId: string;
  turns: number[];
  limit: LimitEvent | null;
  liveness: LivenessResult;
  /** Claude Code's own status for the session: idle / busy / shell. */
  status: string | null;
}

/** Phase 1: everything that touches the filesystem. */
function observe(state: State, ownSessionId: string | null): SessionObservation[] {
  const ids = ownSessionId ? [ownSessionId] : Object.keys(state.sessions);
  const out: SessionObservation[] = [];

  for (const id of ids) {
    const session = state.sessions[id];
    const liveness = session
      ? checkSessionLiveness(id, session.procStart, session.pid)
      : 'unknown';

    const status = (readSessionFiles() ?? []).find((d) => d.sessionId === id)?.status ?? null;

    const file = findTranscript(id);
    if (!file) {
      out.push({ sessionId: id, turns: [], limit: null, liveness, status });
      continue;
    }

    const from = readOffsets.get(id) ?? 0;
    const { records, offset } = readSince(file, from);
    readOffsets.set(id, offset);

    out.push({
      sessionId: id,
      turns: userTurnTimes(records),
      limit: latestLimitEvent(records),
      liveness,
      status,
    });
  }
  return out;
}

/** Fold a limit event into the ledger and the session record. */
export function absorbLimit(state: State, sessionId: string | null, event: LimitEvent, now: number): State {
  const next: State = { ...state, sessions: { ...state.sessions } };
  const session = sessionId ? next.sessions[sessionId] : undefined;

  // A limit recorded before we took charge belongs to an earlier run of the
  // same session id. Transcripts are reused across resumes, so acting on one
  // would type into a terminal the user has only just opened.
  if (session && event.detectedAt < session.supervisedFrom) {
    return state;
  }

  if (event.kind === 'weekly' && event.resetAt !== null) {
    // Idle claims stay suspended until the weekly cap actually clears; otherwise
    // the tool would spend the very budget it exists to protect.
    next.weekly = { ...next.weekly, suspendedUntil: event.resetAt };
  }

  if (event.kind === 'session' && event.resetAt !== null) {
    next.ledger = applyObservation(
      next.ledger,
      { end: event.resetAt, start: event.resetAt - WINDOW_MS, source: 'reset-message' },
      now,
    );
  }

  if (session) {
    next.sessions[session.sessionId] = {
      ...session,
      limit: event,
      // Only a session limit with a readable reset is worth waiting for. A
      // weekly cap is days away and a model cap never clears by waiting.
      pendingResume: event.kind === 'session' && event.resetAt !== null,
      updatedAt: now,
    };
  }
  return next;
}

/** Keep the ledger current from ordinary conversation activity. */
export function absorbTurns(state: State, turns: number[], now: number): State {
  const last = turns[turns.length - 1];
  if (last === undefined) return state;

  const known = state.ledger.currentEnd;
  if (known === null || last >= known) {
    const { start, end } = computeWindow(last);
    return {
      ...state,
      ledger: applyObservation(state.ledger, { start, end, source: 'computed' }, now),
    };
  }
  return state;
}

/**
 * Drop sessions whose process is really gone.
 *
 * `unknown` is not `gone`: descriptors are rewritten continuously, and treating
 * one unreadable poll as death would silently unsupervise a live session with
 * no way back — `registerSession` is only ever called once, at startup.
 */
export function applyLiveness(state: State, observations: SessionObservation[]): State {
  const sessions: Record<string, SupervisedSession> = { ...state.sessions };

  for (const obs of observations) {
    const session = sessions[obs.sessionId];
    if (!session) continue;

    if (obs.liveness === 'alive') {
      if (session.missedLivenessChecks !== 0 || session.sessionStatus !== obs.status) {
        sessions[obs.sessionId] = {
          ...session,
          missedLivenessChecks: 0,
          sessionStatus: obs.status,
        };
      }
      continue;
    }
    if (obs.liveness === 'gone') {
      delete sessions[obs.sessionId];
      continue;
    }
    const missed = session.missedLivenessChecks + 1;
    if (missed >= MAX_MISSED_LIVENESS) {
      delete sessions[obs.sessionId];
    } else {
      sessions[obs.sessionId] = { ...session, missedLivenessChecks: missed };
    }
  }
  return { ...state, sessions };
}

export interface TickContext {
  actor: Actor;
  /** Perform the in-place continuation. Only meaningful for a PTY owner. */
  resume: (sessionId: string) => Promise<boolean>;
  config: Config;
}

/** One supervision tick. Returns the decision taken, for logging and tests. */
export async function tick(ctx: TickContext): Promise<ClaimDecision> {
  const now = Date.now();
  const observations = observe(readState(), ctx.actor.ownSessionId);

  const decision = await updateState((state) => {
    // An impossible ledger (a claim at or after the window it opened) would
    // otherwise make every boundary unreachable for ever.
    let next: State = { ...state, ledger: repairLedger(state.ledger) };
    next = applyLiveness(next, observations);

    for (const obs of observations) {
      if (!next.sessions[obs.sessionId]) continue;
      next = absorbTurns(next, obs.turns, now);
      if (obs.limit) {
        const existing = next.sessions[obs.sessionId]?.limit;
        if (!existing || existing.detectedAt !== obs.limit.detectedAt) {
          next = absorbLimit(next, obs.sessionId, obs.limit, now);
        }
      }
    }

    const d = decideClaim(next, ctx.config, now, ctx.actor);

    // Take an owned hold only for actions this process will actually attempt.
    if (d.action === 'resume' || d.action === 'ping') {
      next = { ...next, ledger: reserveBoundary(next.ledger, ctx.actor.id, now) };
    }
    return { next, result: d };
  });

  if (decision.action === 'none') return decision;

  if (decision.action === 'defer') {
    // The boundary belongs to whichever process owns that session's PTY. Say so
    // and touch nothing: no reservation was taken, so nothing needs releasing.
    logInfo('boundary.deferred', { sessionId: decision.sessionId, reason: decision.reason });
    return decision;
  }

  logAction('boundary.attempt', { action: decision.action, reason: decision.reason });

  if (decision.action === 'resume') {
    const ok = await ctx.resume(decision.sessionId);
    await updateState((state) => {
      const session = state.sessions[decision.sessionId];
      let ledger = state.ledger;
      if (ok) {
        const commit = commitClaim(ledger, ctx.actor.id, Date.now());
        ledger = commit.ledger;
        if (!commit.committed) {
          // Our hold lapsed while we were acting; another actor owns this
          // boundary now. The continuation still happened, so it must still be
          // counted — but the boundary is not ours to record.
          logWarn('commit.lost_reservation', { sessionId: decision.sessionId });
        }
      } else {
        ledger = releaseReservation(ledger, ctx.actor.id);
      }
      const next: State = { ...state, ledger };
      if (session) {
        next.sessions = {
          ...state.sessions,
          [decision.sessionId]: {
            ...session,
            pendingResume: ok ? false : session.pendingResume,
            resumeCount: session.resumeCount + (ok ? 1 : 0),
            updatedAt: Date.now(),
          },
        };
      }
      return { next, result: undefined };
    });
    logAction(ok ? 'resume.ok' : 'resume.failed', { sessionId: decision.sessionId });
    return decision;
  }

  const result = await sendPingWithRetry(ctx.config.pingText);
  await mutateState((state) => {
    if (result.ok) {
      const stamped = Date.now();
      const commit = commitClaim(state.ledger, ctx.actor.id, stamped);
      if (!commit.committed) logWarn('commit.lost_reservation', { action: 'ping' });
      return {
        ...state,
        ledger: commit.ledger,
        weekly: {
          ...state.weekly,
          // Trimmed on write as well as on read, so the list cannot grow without
          // bound in a state file that lives for months.
          idleClaims: [...state.weekly.idleClaims, stamped].filter((t) => stamped - t < WEEK_MS),
        },
      };
    }
    const next: State = { ...state, ledger: releaseReservation(state.ledger, ctx.actor.id) };
    if (result.failure?.kind === 'terminal') {
      // Retrying cannot fix this, and a daemon repeating it forever is noise
      // nobody reads. Stop, and make the reason impossible to miss.
      next.halted = {
        reason: result.failure.reason,
        detectedAt: Date.now(),
        detail: result.failure.detail,
      };
    }
    return next;
  });

  if (!result.ok) {
    if (result.failure?.kind === 'terminal') {
      logError('halted', { reason: result.failure.reason, detail: result.failure.detail });
    } else {
      logWarn('ping.gave_up', { detail: result.detail });
    }
  }
  return decision;
}

/**
 * Rebuild the ledger from conversation history when we have none.
 *
 * Without this the daemon can only ever advance the ledger by its own claims,
 * so a fresh install has no idea when the current window ends and never acts.
 */
export async function bootstrapLedger(): Promise<boolean> {
  if (readState().ledger.currentEnd !== null) return false;

  const derived = deriveLedgerFromTurns(allUserTurnTimes());
  if (!derived) return false;

  const now = Date.now();
  await mutateState((state) => ({
    ...state,
    ledger: applyObservation(state.ledger, { ...derived, source: 'computed' }, now),
  }));
  logInfo('ledger.bootstrapped', {
    start: new Date(derived.start).toISOString(),
    end: new Date(derived.end).toISOString(),
  });
  return true;
}

/** Register a wrapped session so the daemon and `ckm status` can see it. */
export async function registerSession(
  session: Omit<
    SupervisedSession,
    'registeredAt' | 'updatedAt' | 'missedLivenessChecks' | 'supervisedFrom' | 'sessionStatus' | 'hasDraftInput'
  >,
): Promise<void> {
  const now = Date.now();
  readOffsets.delete(session.sessionId);
  await mutateState((state) => {
    const previous = state.sessions[session.sessionId];
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [session.sessionId]: {
          ...session,
          // Carry the count forward: the cap is per session, not per process.
          resumeCount: previous?.resumeCount ?? 0,
          supervisedFrom: now,
          sessionStatus: null,
          hasDraftInput: false,
          missedLivenessChecks: 0,
          registeredAt: now,
          updatedAt: now,
        },
      },
    };
  });
  logInfo('session.registered', { sessionId: session.sessionId, name: session.name });
}

export async function deregisterSession(sessionId: string): Promise<void> {
  readOffsets.delete(sessionId);
  await mutateState((state) => {
    const sessions = { ...state.sessions };
    delete sessions[sessionId];
    return { ...state, sessions };
  });
  logInfo('session.deregistered', { sessionId });
}

/**
 * Publish whether the user has an unsubmitted draft.
 *
 * Only the process owning the PTY can know this, so only it reports it — and it
 * must, so that `ckm status` can report it.
 */
export async function reportDraftInput(sessionId: string, hasDraft: boolean): Promise<void> {
  await mutateState((state) => {
    const session = state.sessions[sessionId];
    if (!session || session.hasDraftInput === hasDraft) return state;
    return {
      ...state,
      sessions: { ...state.sessions, [sessionId]: { ...session, hasDraftInput: hasDraft } },
    };
  });
}

/** Re-check eligibility at the moment of acting, not at the moment of planning. */
export function stillEligible(sessionId: string, config = loadConfig()): boolean {
  const state = readState();
  if (state.globalPaused || state.halted) return false;
  const session = state.sessions[sessionId];
  if (!session) return false;
  return sessionResumable(session, config, Date.now()).ok;
}
