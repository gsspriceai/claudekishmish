/**
 * Tests for the claim protocol itself.
 *
 * The previous suite never imported `tick`, which is where the entire
 * claim-once invariant lives — so the defect that made the shipped
 * configuration inert (a daemon consuming a boundary it could not act on) was
 * invisible to it. These tests run the real `tick` with two actors against the
 * real state store.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../src/config/index.js';
import type { LimitEvent, State, SupervisedSession } from '../src/state/schema.js';
import { emptyState } from '../src/state/schema.js';
import { WINDOW_MS } from '../src/window/ledger.js';
import { absorbLimit, tick } from '../src/supervisor/index.js';
import { mutateState, readState } from '../src/state/store.js';

let ckmHome: string;
let claudeHome: string;

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
// idleClaim is off here on purpose: these tests must never spawn a real
// `claude` process, and the ping path is covered by ping.test.ts.
const config: Config = {
  ...DEFAULT_CONFIG,
  boundaryBufferMs: 0,
  resumeDeferGraceMs: 60_000,
  idleClaim: false,
};

beforeEach(() => {
  ckmHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-sup-'));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-sup-claude-'));
  process.env.CKM_HOME = ckmHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;

  // A live, interactive descriptor for our own pid, so liveness checks pass.
  const sessionsDir = path.join(claudeHome, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: SESSION_ID,
      cwd: '/repo',
      procStart: 'stamp-1',
      kind: 'interactive',
      entrypoint: 'cli',
      name: 'repo-1',
      status: 'busy',
    }),
  );
});

afterEach(() => {
  delete process.env.CKM_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(ckmHome, { recursive: true, force: true });
  fs.rmSync(claudeHome, { recursive: true, force: true });
});

/** A session that is limited, past its reset, and waiting to be continued. */
async function seedPendingSession(): Promise<number> {
  const boundary = Date.now() - 30_000;
  const supervisedFrom = boundary - 3600_000;
  const limit: LimitEvent = {
    kind: 'session',
    detectedAt: boundary - 1800_000,
    resetAt: boundary,
    raw: "You've hit your session limit · resets 2pm (Asia/Calcutta)",
  };
  const session: SupervisedSession = {
    sessionId: SESSION_ID,
    pid: process.pid,
    procStart: 'stamp-1',
    cwd: '/repo',
    name: 'repo-1',
    ptyOwned: true,
    sessionStatus: 'idle',
    hasDraftInput: false,
    supervisedFrom,
    paused: false,
    pendingResume: true,
    resumeCount: 0,
    limit,
    missedLivenessChecks: 0,
    registeredAt: supervisedFrom,
    updatedAt: boundary,
  };

  await mutateState((s: State) => ({
    ...emptyState(Date.now()),
    ...s,
    ledger: {
      currentStart: boundary - WINDOW_MS,
      currentEnd: boundary,
      lastClaimedBoundary: null,
      reservation: null,
      source: 'reset-message',
    },
    sessions: { [SESSION_ID]: session },
  }));
  return boundary;
}

describe('tick — two actors on one boundary', () => {
  it('the daemon does NOT consume a boundary it cannot act on', async () => {
    const boundary = await seedPendingSession();

    let daemonResumed = false;
    const decision = await tick({
      actor: { id: 'daemon-1', ownSessionId: null },
      resume: async () => {
        daemonResumed = true;
        return true;
      },
      config,
    });

    expect(decision.action).toBe('defer');
    expect(daemonResumed).toBe(false);

    const after = readState();
    // The boundary must still be available for the process that owns the PTY.
    expect(after.ledger.lastClaimedBoundary).toBeNull();
    expect(after.ledger.currentEnd).toBe(boundary);
    expect(after.ledger.reservation).toBeNull();
    expect(after.sessions[SESSION_ID]?.pendingResume).toBe(true);
  });

  it('the pty owner then continues the session and claims the boundary', async () => {
    const boundary = await seedPendingSession();

    await tick({ actor: { id: 'daemon-1', ownSessionId: null }, resume: async () => true, config });

    const resumed: string[] = [];
    const decision = await tick({
      actor: { id: 'wrapper-1', ownSessionId: SESSION_ID },
      resume: async (id) => {
        resumed.push(id);
        return true;
      },
      config,
    });

    expect(decision.action).toBe('resume');
    expect(resumed).toEqual([SESSION_ID]);

    const after = readState();
    expect(after.ledger.lastClaimedBoundary).toBe(boundary);
    expect(after.sessions[SESSION_ID]?.resumeCount).toBe(1);
    expect(after.sessions[SESSION_ID]?.pendingResume).toBe(false);
  });

  it('a failed continuation releases the boundary instead of burning it', async () => {
    const boundary = await seedPendingSession();

    const decision = await tick({
      actor: { id: 'wrapper-1', ownSessionId: SESSION_ID },
      resume: async () => false,
      config,
    });

    expect(decision.action).toBe('resume');
    const after = readState();
    // Nothing was sent, so nothing may be claimed.
    expect(after.ledger.lastClaimedBoundary).toBeNull();
    expect(after.ledger.reservation).toBeNull();
    expect(after.sessions[SESSION_ID]?.resumeCount).toBe(0);
    expect(after.sessions[SESSION_ID]?.pendingResume).toBe(true);
    expect(after.ledger.currentEnd).toBe(boundary);
  });

  it('does not continue twice for the same boundary', async () => {
    await seedPendingSession();
    const resumed: string[] = [];
    const run = () =>
      tick({
        actor: { id: 'wrapper-1', ownSessionId: SESSION_ID },
        resume: async (id) => {
          resumed.push(id);
          return true;
        },
        config,
      });

    await run();
    await run();
    expect(resumed).toHaveLength(1);
  });

  it('a paused session is left alone, and nothing else claims the boundary', async () => {
    await seedPendingSession();
    await mutateState((s) => ({
      ...s,
      sessions: { ...s.sessions, [SESSION_ID]: { ...s.sessions[SESSION_ID]!, paused: true } },
    }));

    let resumed = false;
    const decision = await tick({
      actor: { id: 'wrapper-1', ownSessionId: SESSION_ID },
      resume: async () => {
        resumed = true;
        return true;
      },
      config,
    });

    expect(resumed).toBe(false);
    expect(decision.action).toBe('none');
    expect(readState().ledger.lastClaimedBoundary).toBeNull();
  });
});

describe('absorbLimit', () => {
  const now = Date.UTC(2026, 7, 9, 14, 0);

  function bareSession(overrides: Partial<SupervisedSession> = {}): SupervisedSession {
    return {
      sessionId: SESSION_ID,
      pid: 1,
      procStart: null,
      cwd: '/repo',
      name: 'r',
      ptyOwned: true,
      sessionStatus: 'idle',
      hasDraftInput: false,
      supervisedFrom: now - 60_000,
      paused: false,
      pendingResume: false,
      resumeCount: 0,
      limit: null,
      missedLivenessChecks: 0,
      registeredAt: now - 60_000,
      updatedAt: now,
      ...overrides,
    };
  }

  function stateWith(session: SupervisedSession): State {
    return { ...emptyState(now), sessions: { [session.sessionId]: session } };
  }

  it('ignores a limit recorded before supervision began', () => {
    // 13 of 14 real transcripts on the author's machine contain a rate_limit
    // record followed by later user turns, so this is the common case, not an
    // edge case.
    const state = stateWith(bareSession());
    const historical: LimitEvent = {
      kind: 'session',
      detectedAt: now - 26 * 3600_000,
      resetAt: now - 21 * 3600_000,
      raw: "You've hit your session limit · resets 5am (Asia/Calcutta)",
    };
    const next = absorbLimit(state, SESSION_ID, historical, now);
    expect(next.sessions[SESSION_ID]?.pendingResume).toBe(false);
    expect(next.ledger.currentEnd).toBeNull();
  });

  it('accepts a limit from this supervision run', () => {
    const state = stateWith(bareSession());
    const live: LimitEvent = {
      kind: 'session',
      detectedAt: now - 1000,
      resetAt: now + 3600_000,
      raw: "You've hit your session limit · resets 3pm (Asia/Calcutta)",
    };
    const next = absorbLimit(state, SESSION_ID, live, now);
    expect(next.sessions[SESSION_ID]?.pendingResume).toBe(true);
    expect(next.ledger.source).toBe('reset-message');
  });

  it('parks a weekly limit and suspends idle claiming', () => {
    const state = stateWith(bareSession());
    const weekly: LimitEvent = {
      kind: 'weekly',
      detectedAt: now - 1000,
      resetAt: now + 2 * 24 * 3600_000,
      raw: "You've hit your weekly limit · resets Aug 11, 10:30pm (Asia/Calcutta)",
    };
    const next = absorbLimit(state, SESSION_ID, weekly, now);
    expect(next.sessions[SESSION_ID]?.pendingResume).toBe(false);
    expect(next.weekly.suspendedUntil).toBe(weekly.resetAt);
  });

  it('never marks a model limit as pending', () => {
    const state = stateWith(bareSession());
    const model: LimitEvent = {
      kind: 'model',
      detectedAt: now - 1000,
      resetAt: null,
      raw: "You've reached your Fable 5 limit. Run /usage-credits to continue",
    };
    expect(absorbLimit(state, SESSION_ID, model, now).sessions[SESSION_ID]?.pendingResume).toBe(false);
  });
});
