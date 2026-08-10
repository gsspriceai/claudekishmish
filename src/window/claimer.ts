/**
 * Decide what to do at a window boundary.
 *
 * Pure function of `(state, config, now, actor)`. Every safety rule is enforced
 * here, so it is deliberately free of I/O: the caller decides here, then acts on
 * the decision outside the lock.
 *
 * The governing rule is that a boundary is consumed **exactly once, by an actor
 * that actually sends a request**:
 *
 *     pending work I can continue?  -> continue it      (continuing *is* claiming)
 *     pending work someone else owns -> defer, briefly  (do not burn it, do not ping)
 *     nothing pending                -> a minimal ping  (only if idle claiming is on)
 *
 * `defer` exists because only the process owning a session's PTY can type into
 * it. Without it the daemon decides "resume", cannot act, and the boundary is
 * lost with nothing sent — which is both halves of the product failing at once.
 * The deferral is time-bounded so a dead PTY owner cannot strand the boundary
 * forever.
 */

import type { Config } from '../config/index.js';
import type { State, SupervisedSession } from '../state/schema.js';
import { isBoundaryDue, nextBoundary, reservedByOther } from './ledger.js';

export type ClaimDecision =
  | { action: 'resume'; sessionId: string; reason: string }
  | { action: 'ping'; reason: string }
  | { action: 'defer'; sessionId: string; reason: string }
  | { action: 'none'; reason: string };

export const WEEK_MS = 7 * 24 * 3600_000;

/** Identifies who is deciding, and what they are physically able to do. */
export interface Actor {
  /** Stable per-process id, used to own reservations. */
  id: string;
  /** The one session this actor owns a PTY for, if any. */
  ownSessionId: string | null;
}

/** Idle claims inside the trailing seven days. */
export function recentIdleClaims(state: State, now: number): number[] {
  return state.weekly.idleClaims.filter((t) => now - t < WEEK_MS);
}

/**
 * Is this session eligible for an automatic continuation right now?
 *
 * Every clause here is a safety rule, not an optimisation.
 */
export function sessionResumable(
  session: SupervisedSession,
  config: Config,
  now: number,
): { ok: boolean; reason: string } {
  if (session.paused) return { ok: false, reason: 'session paused by user' };
  if (!session.pendingResume) return { ok: false, reason: 'nothing pending' };
  if (!session.ptyOwned) return { ok: false, reason: 'we do not own this pty' };
  if (!session.limit) return { ok: false, reason: 'no recorded limit' };

  if (session.limit.kind === 'model') {
    return { ok: false, reason: 'model limit is out of scope — waiting cannot clear it' };
  }
  if (session.limit.kind === 'weekly') {
    return { ok: false, reason: 'weekly limits are not auto-continued' };
  }

  // The limit must belong to *this* supervision run. A transcript is reused
  // across resumes, so an old record would otherwise make us type into a
  // terminal the user has only just opened.
  if (session.limit.detectedAt < session.supervisedFrom) {
    return { ok: false, reason: 'limit predates this session — historical, not live' };
  }
  // And the reset itself must actually have arrived.
  if (session.limit.resetAt === null) {
    return { ok: false, reason: 'no reset time could be read' };
  }
  if (now < session.limit.resetAt) {
    return { ok: false, reason: 'the stated reset has not passed yet' };
  }

  if (session.resumeCount >= config.maxResumesPerSession) {
    return {
      ok: false,
      reason: `resume cap reached (${session.resumeCount}/${config.maxResumesPerSession})`,
    };
  }
  return { ok: true, reason: 'eligible' };
}

/** Is an idle ping allowed right now? */
export function idleClaimAllowed(
  state: State,
  config: Config,
  now: number,
): { ok: boolean; reason: string } {
  if (!config.idleClaim) return { ok: false, reason: 'idle claiming is off (ckm claim on)' };
  if (state.weekly.suspendedUntil !== null && now < state.weekly.suspendedUntil) {
    return { ok: false, reason: 'suspended after a weekly limit' };
  }
  const used = recentIdleClaims(state, now).length;
  if (used >= config.maxIdleClaimsPerWeek) {
    return {
      ok: false,
      reason: `weekly idle-claim cap reached (${used}/${config.maxIdleClaimsPerWeek})`,
    };
  }
  return { ok: true, reason: 'allowed' };
}

/** What should happen at this instant, for this actor. */
export function decideClaim(
  state: State,
  config: Config,
  now: number,
  actor: Actor,
): ClaimDecision {
  if (state.halted && (state.halted.expiresAt === null || now < state.halted.expiresAt)) {
    const until =
      state.halted.expiresAt === null
        ? 'fix it, then `ckm resume --all`'
        : `lifts by itself at ${new Date(state.halted.expiresAt).toLocaleTimeString()}`;
    return { action: 'none', reason: `halted: ${state.halted.detail} (${until})` };
  }
  if (state.globalPaused) {
    return { action: 'none', reason: 'paused globally (ckm resume --all to re-enable)' };
  }
  if (!isBoundaryDue(state.ledger, now, config.boundaryBufferMs)) {
    return { action: 'none', reason: 'boundary not due' };
  }
  if (reservedByOther(state.ledger, actor.id, now)) {
    return { action: 'none', reason: 'another actor is already acting on this boundary' };
  }

  const boundary = nextBoundary(state.ledger);

  if (config.autoContinue) {
    // Oldest interruption first, so the longest-waiting task goes first.
    const candidates = Object.values(state.sessions)
      .filter((s) => sessionResumable(s, config, now).ok)
      .sort((a, b) => (a.limit?.detectedAt ?? 0) - (b.limit?.detectedAt ?? 0));

    const mine = candidates.find((s) => s.sessionId === actor.ownSessionId);
    if (mine) {
      return {
        action: 'resume',
        sessionId: mine.sessionId,
        reason: `continuing "${mine.name}" (${candidates.length} pending)`,
      };
    }

    const other = candidates[0];
    if (other) {
      // Someone else owns that PTY. Hold off rather than consuming the boundary
      // they need — but not indefinitely, in case that process is gone.
      const graceOver =
        boundary !== null && now >= boundary + config.boundaryBufferMs + config.resumeDeferGraceMs;
      if (!graceOver) {
        return {
          action: 'defer',
          sessionId: other.sessionId,
          reason: `"${other.name}" is owned by another process — letting it continue`,
        };
      }
    }
  }

  const idle = idleClaimAllowed(state, config, now);
  if (idle.ok) {
    // Deliberately a fresh session rather than typing into one that is already
    // open. A terminal sitting idle may still hold work the user cares about,
    // and a claim is not worth the risk of disturbing it.
    return { action: 'ping', reason: 'no pending work — claiming with a new session' };
  }

  return { action: 'none', reason: idle.reason };
}
