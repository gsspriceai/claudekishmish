/**
 * Decide what to do at a window boundary.
 *
 * Pure function of `(state, config, now)`. This is where every safety rule is
 * enforced, so it is deliberately free of I/O: the caller decides here, then
 * acts on the decision outside the lock.
 *
 * The governing rule is that a boundary is claimed **exactly once**, by exactly
 * one actor:
 *
 *     pending work?  -> continue it        (continuing *is* claiming)
 *     otherwise      -> a minimal ping     (only if idle claiming is enabled)
 *
 * Doing both would claim the same window twice and spend tokens for nothing.
 */

import type { Config } from '../config/index.js';
import type { State, SupervisedSession } from '../state/schema.js';
import { isBoundaryDue } from './ledger.js';

export type ClaimDecision =
  | { action: 'resume'; sessionId: string; reason: string }
  | { action: 'ping'; reason: string }
  | { action: 'none'; reason: string };

export const WEEK_MS = 7 * 24 * 3600_000;

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
    const reset = session.limit.resetAt;
    if (reset !== null && now < reset) {
      return { ok: false, reason: 'weekly limit has not reset yet' };
    }
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
    return { ok: false, reason: `weekly idle-claim cap reached (${used}/${config.maxIdleClaimsPerWeek})` };
  }
  return { ok: true, reason: 'allowed' };
}

/** What should happen at this instant. */
export function decideClaim(state: State, config: Config, now: number): ClaimDecision {
  if (state.globalPaused) {
    return { action: 'none', reason: 'paused globally (ckm resume --all to re-enable)' };
  }
  if (!isBoundaryDue(state.ledger, now, config.boundaryBufferMs)) {
    return { action: 'none', reason: 'boundary not due' };
  }

  if (config.autoContinue) {
    // Oldest interruption first, so the longest-waiting task goes first.
    const candidates = Object.values(state.sessions)
      .filter((s) => sessionResumable(s, config, now).ok)
      .sort((a, b) => (a.limit?.detectedAt ?? 0) - (b.limit?.detectedAt ?? 0));

    const first = candidates[0];
    if (first) {
      return {
        action: 'resume',
        sessionId: first.sessionId,
        reason: `continuing "${first.name}" (${candidates.length} pending)`,
      };
    }
  }

  const idle = idleClaimAllowed(state, config, now);
  if (idle.ok) return { action: 'ping', reason: 'no pending work — claiming the boundary' };

  return { action: 'none', reason: idle.reason };
}
