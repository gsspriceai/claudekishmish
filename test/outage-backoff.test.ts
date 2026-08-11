/**
 * What the tool does about an outage, as opposed to how it recognises one.
 *
 * The dangerous property here is the attempt count. Every failed continuation
 * writes a *new* error record, so an implementation that treats each record as
 * a fresh outage resets the counter every time — turning a hard cap of five
 * into an unbounded retry loop against an API that is already failing. That is
 * the single worst thing this feature could do, so most of this file is about
 * it.
 */

import { describe, expect, it } from 'vitest';
import { absorbOutage, absorbUserRecovery } from '../src/supervisor/index.js';
import { outageResumable } from '../src/window/claimer.js';
import { DEFAULT_CONFIG, type Config } from '../src/config/index.js';
import { emptyState, type State, type SupervisedSession } from '../src/state/schema.js';
import type { OutageEvent } from '../src/claude/outage.js';

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const T = 1_786_000_000_000;
const config: Config = { ...DEFAULT_CONFIG, outageBackoffMs: 30_000, outageBackoffCapMs: 480_000 };

function session(over: Partial<SupervisedSession> = {}): SupervisedSession {
  return {
    sessionId: ID,
    pid: 1234,
    procStart: 'stamp',
    cwd: '/repo',
    name: 'repo',
    ptyOwned: true,
    sessionStatus: 'idle',
    hasDraftInput: false,
    supervisedFrom: T - 60_000,
    paused: false,
    pendingResume: false,
    resumeCount: 0,
    limit: null,
    outage: null,
    missedLivenessChecks: 0,
    registeredAt: T - 60_000,
    updatedAt: T,
    ...over,
  };
}

function stateWith(over: Partial<SupervisedSession> = {}): State {
  return { ...emptyState(T), sessions: { [ID]: session(over) } };
}

function outage(over: Partial<OutageEvent> = {}): OutageEvent {
  return {
    detectedAt: T,
    status: 529,
    error: 'unknown',
    raw: 'API Error: Overloaded',
    attempts: 0,
    retryAt: T + 30_000,
    ...over,
  };
}

describe('absorbOutage', () => {
  it('records the outage and marks the session pending', () => {
    const after = absorbOutage(stateWith(), ID, outage(), config, T);
    expect(after.sessions[ID]!.outage!.raw).toBe('API Error: Overloaded');
    expect(after.sessions[ID]!.pendingResume).toBe(true);
  });

  it('ignores an error that predates this supervision run', () => {
    // A transcript is reused across resumes. Acting on an old record would
    // type into a terminal the user has only just opened — the same defect
    // that was already fixed once for limits.
    const before = stateWith({ supervisedFrom: T });
    const after = absorbOutage(before, ID, outage({ detectedAt: T - 120_000 }), config, T);
    expect(after).toBe(before);
    expect(after.sessions[ID]!.outage).toBeNull();
  });

  it('KEEPS the attempt count when a new error arrives in the same episode', () => {
    // The whole point. Our continuation failed and Claude logged a second
    // error; that is the same outage, not a new one.
    const before = stateWith({ outage: outage({ attempts: 3 }), pendingResume: true });
    const after = absorbOutage(before, ID, outage({ detectedAt: T + 60_000 }), config, T + 60_000);

    expect(after.sessions[ID]!.outage!.attempts).toBe(3);
  });

  it('backs off further on each new error in the same episode', () => {
    const before = stateWith({ outage: outage({ attempts: 2 }), pendingResume: true });
    const now = T + 60_000;
    const after = absorbOutage(before, ID, outage({ detectedAt: now }), config, now);

    // 30s * 2^2 = 120s from now, not from the original failure.
    expect(after.sessions[ID]!.outage!.retryAt).toBe(now + 120_000);
  });

  it('starts a fresh count once the user has carried on themselves', () => {
    // Otherwise one bad afternoon exhausts the cap for the rest of the day.
    const stalled = stateWith({ outage: outage({ attempts: 4 }), pendingResume: true });
    const recovered = absorbUserRecovery(stalled, ID, [T + 30_000]);
    expect(recovered.sessions[ID]!.outage).toBeNull();
    expect(recovered.sessions[ID]!.pendingResume).toBe(false);

    const again = absorbOutage(recovered, ID, outage({ detectedAt: T + 90_000 }), config, T + 90_000);
    expect(again.sessions[ID]!.outage!.attempts).toBe(0);
  });

  it('does nothing for the identical record seen twice', () => {
    // Ticks overlap; the same line must not re-arm the backoff.
    const before = absorbOutage(stateWith(), ID, outage(), config, T);
    const again = absorbOutage(before, ID, outage(), config, T + 5_000);
    expect(again.sessions[ID]!.outage!.retryAt).toBe(before.sessions[ID]!.outage!.retryAt);
  });
});

describe('outageResumable', () => {
  it('waits for the backoff before the first attempt', () => {
    const s = session({ outage: outage(), pendingResume: true });
    expect(outageResumable(s, config, T + 10_000).ok).toBe(false);
    expect(outageResumable(s, config, T + 30_001).ok).toBe(true);
  });

  it('stops at the cap instead of retrying for ever', () => {
    const s = session({ outage: outage({ attempts: config.maxOutageRetries, retryAt: T }), pendingResume: true });
    const verdict = outageResumable(s, config, T + 10_000);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/cap reached/);
  });

  it('refuses an outage older than this supervision run', () => {
    const s = session({ supervisedFrom: T, outage: outage({ detectedAt: T - 60_000, retryAt: T - 30_000 }), pendingResume: true });
    expect(outageResumable(s, config, T + 60_000).ok).toBe(false);
  });

  it('still honours the per-session resume cap', () => {
    const s = session({
      outage: outage({ retryAt: T }),
      pendingResume: true,
      resumeCount: config.maxResumesPerSession,
    });
    expect(outageResumable(s, config, T + 60_000).reason).toMatch(/resume cap/);
  });

  it('says how long is left, rather than just refusing', () => {
    const s = session({ outage: outage({ retryAt: T + 45_000 }), pendingResume: true });
    expect(outageResumable(s, config, T).reason).toMatch(/45s to go/);
  });
});

/**
 * The two causes must not be confused. A limit states exactly when it lifts; an
 * outage is a guess. Guessing during a limit sends requests that cannot succeed.
 */
describe('a limit outranks an outage', () => {
  it('a session with both is judged on the limit', async () => {
    const { sessionResumable } = await import('../src/window/claimer.js');
    const s = session({
      pendingResume: true,
      outage: outage({ retryAt: T }), // ready to retry
      limit: {
        kind: 'session',
        detectedAt: T,
        resetAt: T + 3_600_000, // but the limit does not lift for an hour
        raw: "You've hit your session limit",
      },
    });

    const verdict = sessionResumable(s, config, T + 60_000);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/reset has not passed/);
  });

  it('an outage alone is judged on the outage', async () => {
    const { sessionResumable } = await import('../src/window/claimer.js');
    const s = session({ pendingResume: true, outage: outage({ retryAt: T }) });
    expect(sessionResumable(s, config, T + 60_000).ok).toBe(true);
  });

  it('neither is still nothing to do', async () => {
    const { sessionResumable } = await import('../src/window/claimer.js');
    expect(sessionResumable(session({ pendingResume: true }), config, T).ok).toBe(false);
  });
});

/**
 * Upgrading, with work already in flight.
 *
 * A session record written by a build that predates the `outage` field has no
 * such key, so it arrives as `undefined` rather than `null`. Code that checks
 * `!== null` then reads a property off nothing and throws — and it throws in
 * `tick`, meaning every poll fails, on exactly the machines that were already
 * using the tool. It is the cheapest possible bug to write and one of the
 * worst to ship.
 */
describe('a session record from an older build', () => {
  /** No `outage` key at all — what `state.json` actually holds after an upgrade. */
  function legacy(): SupervisedSession {
    const s = session();
    delete (s as Partial<SupervisedSession>).outage;
    return s;
  }

  it('does not throw when an outage arrives for it', () => {
    const before: State = { ...emptyState(T), sessions: { [ID]: legacy() } };
    const after = absorbOutage(before, ID, outage(), config, T);
    expect(after.sessions[ID]!.outage!.attempts).toBe(0);
  });

  it('is judged as having no outage, rather than crashing the gate', () => {
    const verdict = outageResumable({ ...legacy(), pendingResume: true }, config, T);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('no recorded outage');
  });

  it('still recovers normally', () => {
    const before: State = {
      ...emptyState(T),
      sessions: { [ID]: { ...legacy(), pendingResume: true, limit: { kind: 'session', detectedAt: T, resetAt: T, raw: 'x' } } },
    };
    expect(absorbUserRecovery(before, ID, [T + 1_000]).sessions[ID]!.pendingResume).toBe(false);
  });
});
