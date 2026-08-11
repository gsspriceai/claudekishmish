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
import type { LimitEvent, State, SupervisedSession } from '../state/schema.js';
import { isBoundaryDue, nextBoundary, reservedByOther } from './ledger.js';

export type ClaimDecision =
  | { action: 'resume'; sessionId: string; reason: string; claimsBoundary: boolean }
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

  // An outage takes the same road as a limit, on purpose: every guard above and
  // below applies to both, and the injection path is shared. What differs is
  // only what we are waiting for — a stated reset, or a backoff we chose.
  //
  // Which cause governs is decided here, and "whichever field is set" is not
  // good enough. A limit that has already reset no longer blocks anything, and
  // a stale one used to win outright: the limit branch found a reset from hours
  // ago, declared the session eligible at once, and skipped the outage's
  // backoff and retry cap — while the attempt counter stayed frozen, because
  // its bookkeeping runs only when there is no limit. A retry loop at tick
  // rate, from a field nobody had cleared.
  //
  // So: a limit that has not yet reset outranks everything, because retrying
  // during it cannot succeed and it states exactly how long to wait. Otherwise
  // the most recent cause governs.
  const outage = session.outage ?? null;
  const limit = session.limit ?? null;

  if (!limit) {
    return outage ? outageResumable(session, config, now) : { ok: false, reason: 'no recorded limit' };
  }
  if (outage && limitHasPassed(limit, config, now) && outage.detectedAt >= limit.detectedAt) {
    return outageResumable(session, config, now);
  }

  if (limit.kind === 'model') {
    return { ok: false, reason: 'model limit is out of scope — waiting cannot clear it' };
  }
  if (limit.kind === 'weekly') {
    return { ok: false, reason: 'weekly limits are not auto-continued' };
  }

  // The limit must belong to *this* supervision run. A transcript is reused
  // across resumes, so an old record would otherwise make us type into a
  // terminal the user has only just opened.
  if (limit.detectedAt < session.supervisedFrom) {
    return { ok: false, reason: 'limit predates this session — historical, not live' };
  }
  // And the reset itself must actually have arrived.
  if (limit.resetAt === null) {
    return { ok: false, reason: 'no reset time could be read' };
  }
  // The same buffer the boundary uses: a request a second after the stated
  // reset can still be refused, and we would be retrying blind.
  if (now < limit.resetAt + Math.max(0, config.boundaryBufferMs)) {
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

/**
 * Has this limit's own stated reset already gone by?
 *
 * A limit past its reset is a record of something that happened, not a thing
 * still blocking work.
 */
function limitHasPassed(limit: LimitEvent, config: Config, now: number): boolean {
  if (limit.kind === 'model' || limit.kind === 'weekly') return false;
  if (limit.resetAt === null) return false;
  return now >= limit.resetAt + Math.max(0, config.boundaryBufferMs);
}

/**
 * When work on this session actually stopped, whichever cause stopped it.
 *
 * Used only for ordering, so the longest-waiting task is continued first. A
 * session with neither is not a candidate and never reaches here.
 */
function interruptedAt(session: SupervisedSession): number {
  return session.limit?.detectedAt ?? session.outage?.detectedAt ?? 0;
}

/**
 * Is this session ready for another attempt after an API outage?
 *
 * Deliberately stricter than the limit path in one respect and looser in
 * another. Stricter: an outage states no reset time, so every attempt is a
 * guess and the number of guesses is hard-capped. Looser: there is no boundary
 * to wait for, because the window is still running — continuing here spends the
 * allowance the user is already inside, not a new one.
 */
export function outageResumable(
  session: SupervisedSession,
  config: Config,
  now: number,
): { ok: boolean; reason: string } {
  // `?? null` for the same reason as in `absorbOutage`: a record from an
  // older build has no such key.
  const outage = session.outage ?? null;
  if (!outage) return { ok: false, reason: 'no recorded outage' };

  // The same rule limits obey: a transcript is reused across resumes, so an
  // error from an earlier run of this session id is history. Acting on it would
  // type into a terminal the user has only just opened.
  if (outage.detectedAt < session.supervisedFrom) {
    return { ok: false, reason: 'outage predates this session — historical, not live' };
  }
  if (outage.attempts >= config.maxOutageRetries) {
    return {
      ok: false,
      reason: `outage retry cap reached (${outage.attempts}/${config.maxOutageRetries}) — ${outage.raw}`,
    };
  }
  if (now < outage.retryAt) {
    const secs = Math.ceil((outage.retryAt - now) / 1000);
    return { ok: false, reason: `backing off after "${outage.raw}" — ${secs}s to go` };
  }
  if (session.resumeCount >= config.maxResumesPerSession) {
    return {
      ok: false,
      reason: `resume cap reached (${session.resumeCount}/${config.maxResumesPerSession})`,
    };
  }
  return { ok: true, reason: `retrying after "${outage.raw}"` };
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

/**
 * What should happen at this instant, for this actor.
 *
 * Continuing and claiming are separate questions, and conflating them stranded
 * work. A session whose stated reset has passed can be continued *now* — the
 * window is already running and continuing it costs no boundary. Gating that on
 * `isBoundaryDue` meant that when two sessions were interrupted, the first one
 * consumed the boundary and the second sat idle for another five hours despite
 * being eligible the whole time.
 *
 * So a resume is offered whenever the session is eligible; it only *claims* the
 * boundary when one is actually due.
 */
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

  const boundaryDue = isBoundaryDue(state.ledger, now, config.boundaryBufferMs);
  const boundaryFree = boundaryDue && !reservedByOther(state.ledger, actor.id, now);

  if (config.autoContinue) {
    // Oldest interruption first, so the longest-waiting task goes first.
    const candidates = Object.values(state.sessions)
      .filter((s) => sessionResumable(s, config, now).ok)
      .sort((a, b) => interruptedAt(a) - interruptedAt(b));

    const mine = candidates.find((s) => s.sessionId === actor.ownSessionId);
    if (mine) {
      return {
        action: 'resume',
        sessionId: mine.sessionId,
        // Only spends the boundary if one is due and nobody else holds it.
        claimsBoundary: boundaryFree,
        reason: boundaryFree
          ? `continuing "${mine.name}" (${candidates.length} pending), claiming the boundary`
          : `continuing "${mine.name}" inside the current window`,
      };
    }

    const other = candidates[0];
    if (other && boundaryDue) {
      // Someone else owns that PTY. Hold off rather than consuming the boundary
      // they need — but not indefinitely, in case that process is gone.
      const boundary = nextBoundary(state.ledger);
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

  // Everything below spends a boundary, so from here on one has to be available.
  if (!boundaryDue) return { action: 'none', reason: 'boundary not due' };
  if (reservedByOther(state.ledger, actor.id, now)) {
    return { action: 'none', reason: 'another actor is already acting on this boundary' };
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
