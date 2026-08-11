/**
 * Call sites, not helpers.
 *
 * An audit introduced nine mutations that the suite did not notice, and the
 * shape of almost all of them was the same: a guard existed, had unit tests, and
 * was either unwired or wired wrongly at the one place it mattered. A function
 * with tests and no caller is not a safety feature.
 *
 * Everything here goes through `tick` or the real store, never through the
 * helper in isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../src/config/index.js';
import { emptyState, type SupervisedSession } from '../src/state/schema.js';
import { computeWindow, WINDOW_MS } from '../src/window/ledger.js';
import { applyLiveness, stillEligible, tick } from '../src/supervisor/index.js';
import { mutateState, readState } from '../src/state/store.js';
import { pingArgs } from '../src/window/ping.js';
import { clearTurnCache } from '../src/claude/turn-cache.js';
import { fileURLToPath } from 'node:url';

const SESSION_ID = 'cccccccc-dddd-eeee-ffff-000000000000';

let ckmHome: string;
let claudeHome: string;
let argsFile: string;
let cwdFile: string;

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeScript = path.join(here, 'fixtures', 'fake-claude-ping.mjs');

const config: Config = { ...DEFAULT_CONFIG, boundaryBufferMs: 0, idleClaim: true };

function writeDescriptor(over: Record<string, unknown> = {}): void {
  const dir = path.join(claudeHome, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const merged = {
    pid: process.pid,
    sessionId: SESSION_ID,
    cwd: '/repo',
    procStart: 'stamp-1',
    kind: 'interactive',
    entrypoint: 'cli',
    name: 'repo',
    status: 'idle',
    ...over,
  };
  fs.writeFileSync(path.join(dir, `${merged.pid}.json`), JSON.stringify(merged));
}

function session(over: Partial<SupervisedSession> = {}): SupervisedSession {
  const now = Date.now();
  return {
    sessionId: SESSION_ID,
    pid: process.pid,
    procStart: 'stamp-1',
    cwd: '/repo',
    name: 'repo',
    ptyOwned: true,
    sessionStatus: 'idle',
    hasDraftInput: false,
    supervisedFrom: now - 7200_000,
    paused: false,
    pendingResume: true,
    resumeCount: 0,
    limit: {
      kind: 'session',
      detectedAt: now - 3600_000,
      resetAt: now - 60_000,
      raw: "You've hit your session limit",
    },
    missedLivenessChecks: 0,
    registeredAt: now - 7200_000,
    updatedAt: now,
    ...over,
  };
}

async function seed(over: Partial<SupervisedSession> = {}): Promise<number> {
  const boundary = Date.now() - 5_000;
  await mutateState(() => ({
    ...emptyState(Date.now()),
    ledger: {
      currentStart: boundary - WINDOW_MS,
      currentEnd: boundary,
      lastClaimedBoundary: null,
      reservation: null,
      source: 'computed',
    },
    sessions: { [SESSION_ID]: session(over) },
  }));
  return boundary;
}

beforeEach(() => {
  ckmHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-wiring-'));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-wiring-claude-'));
  argsFile = path.join(ckmHome, 'args.json');
  cwdFile = path.join(ckmHome, 'cwd.txt');
  process.env.CKM_HOME = ckmHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.FAKE_ARGS_FILE = argsFile;
  process.env.FAKE_CWD_FILE = cwdFile;

  const bin =
    process.platform === 'win32'
      ? path.join(ckmHome, 'fake-claude.cmd')
      : path.join(ckmHome, 'fake-claude');
  if (process.platform === 'win32') {
    fs.writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`, 'utf8');
  } else {
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, 'utf8');
    fs.chmodSync(bin, 0o755);
  }
  process.env.CKM_CLAUDE_BIN = bin;
  writeDescriptor();
});

afterEach(() => {
  for (const k of ['CKM_HOME', 'CLAUDE_CONFIG_DIR', 'FAKE_ARGS_FILE', 'FAKE_CWD_FILE', 'CKM_CLAUDE_BIN']) {
    delete process.env[k];
  }
  fs.rmSync(ckmHome, { recursive: true, force: true });
  fs.rmSync(claudeHome, { recursive: true, force: true });
});

/** M2 — the halt had no end-to-end test at all. */
describe('a terminal failure halts, end to end', () => {
  it('sets the halt, and the next tick sends nothing', async () => {
    await mutateState(() => ({
      ...emptyState(Date.now()),
      ledger: {
        currentStart: Date.now() - WINDOW_MS - 5_000,
        currentEnd: Date.now() - 5_000,
        lastClaimedBoundary: null,
        reservation: null,
        source: 'computed',
      },
    }));
    process.env.FAKE_FAIL_TEXT = 'Not logged in · Please run /login';

    await tick({ actor: { id: 'd', ownSessionId: null }, resume: async () => false, config });
    delete process.env.FAKE_FAIL_TEXT;

    const halted = readState().halted;
    expect(halted).not.toBeNull();
    expect(halted!.reason).toBe('auth');
    // Auth is not self-clearing: only a person can fix a logged-out account.
    expect(halted!.expiresAt).toBeNull();

    fs.rmSync(argsFile, { force: true });
    const again = await tick({
      actor: { id: 'd', ownSessionId: null },
      resume: async () => false,
      config,
    });
    expect(again.action).toBe('none');
    expect(fs.existsSync(argsFile)).toBe(false);
  });

  it('the boundary survives a halt, so nothing is lost when it clears', async () => {
    const boundary = Date.now() - 5_000;
    await mutateState(() => ({
      ...emptyState(Date.now()),
      ledger: {
        currentStart: boundary - WINDOW_MS,
        currentEnd: boundary,
        lastClaimedBoundary: null,
        reservation: null,
        source: 'computed',
      },
    }));
    process.env.FAKE_FAIL_TEXT = 'Not logged in · Please run /login';
    await tick({ actor: { id: 'd', ownSessionId: null }, resume: async () => false, config });
    delete process.env.FAKE_FAIL_TEXT;

    const after = readState();
    expect(after.ledger.lastClaimedBoundary).toBeNull();
    expect(after.ledger.reservation).toBeNull();
  });
});

/** M3 — README safety §7 promises this re-check, and nothing tested it. */
describe('eligibility is re-checked in the instant before typing', () => {
  it('a pause taken after the decision stops the continuation', async () => {
    await seed();
    expect(stillEligible(SESSION_ID, config)).toBe(true);

    await mutateState((s) => ({ ...s, globalPaused: true }));
    expect(stillEligible(SESSION_ID, config)).toBe(false);
  });

  it('a halt taken after the decision stops it too', async () => {
    await seed();
    await mutateState((s) => ({
      ...s,
      halted: { reason: 'auth', detectedAt: Date.now(), detail: 'logged out', expiresAt: null },
    }));
    expect(stillEligible(SESSION_ID, config)).toBe(false);
  });

  it('a session that vanished is not eligible', async () => {
    await seed();
    await mutateState((s) => ({ ...s, sessions: {} }));
    expect(stillEligible(SESSION_ID, config)).toBe(false);
  });
});

/** M4/M5 — the liveness guards, at the call site rather than in the helper. */
describe('liveness, as tick actually uses it', () => {
  it('one unreadable poll does not unsupervise a live session', async () => {
    await seed();
    const state = readState();
    const once = applyLiveness(state, [
      { sessionId: SESSION_ID, turns: [], limit: null, liveness: 'unknown', status: null },
    ]);
    expect(once.sessions[SESSION_ID]).toBeDefined();
    expect(once.sessions[SESSION_ID]!.missedLivenessChecks).toBe(1);
  });

  it('but a long run of them does', async () => {
    await seed();
    let state = readState();
    for (let i = 0; i < 10; i++) {
      state = applyLiveness(state, [
        { sessionId: SESSION_ID, turns: [], limit: null, liveness: 'unknown', status: null },
      ]);
    }
    expect(state.sessions[SESSION_ID]).toBeUndefined();
  });

  it('a recycled pid drops the session rather than inheriting a stranger', async () => {
    await seed();
    // Same session id, different process-start stamp: a different process.
    writeDescriptor({ procStart: 'a-different-process' });

    await tick({ actor: { id: 'w', ownSessionId: SESSION_ID }, resume: async () => true, config });
    expect(readState().sessions[SESSION_ID]).toBeUndefined();
  });

  it('a session that stopped being interactive is dropped', async () => {
    await seed();
    writeDescriptor({ kind: 'background' });

    await tick({ actor: { id: 'w', ownSessionId: SESSION_ID }, resume: async () => true, config });
    expect(readState().sessions[SESSION_ID]).toBeUndefined();
  });
});

/** M8 — the claim must not discover a project. */
describe('the claim runs nowhere near a project', () => {
  it('spawns in a temp directory, not the home or a repo', async () => {
    await mutateState(() => ({
      ...emptyState(Date.now()),
      ledger: {
        currentStart: Date.now() - WINDOW_MS - 5_000,
        currentEnd: Date.now() - 5_000,
        lastClaimedBoundary: null,
        reservation: null,
        source: 'computed',
      },
    }));

    await tick({ actor: { id: 'd', ownSessionId: null }, resume: async () => false, config });

    // Anywhere with a CLAUDE.md or project settings changes the prompt, misses
    // the prompt cache, and costs roughly ten times as much per the measurement
    // in the README.
    // realpath, not resolve: macOS symlinks /var to /private/var, so the same
    // directory compares unequal to itself without it.
    const real = (p: string) => fs.realpathSync.native(path.resolve(p));
    const where = fs.readFileSync(cwdFile, 'utf8').trim();
    expect(real(where)).toBe(real(os.tmpdir()));
    expect(real(where)).not.toBe(real(os.homedir()));
  });

  it('asks for no MCP servers and no skills', () => {
    const args = pingArgs('ok');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
  });
});

/**
 * The reconciler, at its call site.
 *
 * `reconcile.test.ts` proves the rule. This proves `tick` applies it — the
 * distinction that mattered nine separate times in this codebase, where a guard
 * existed, had unit tests, and was wired to nothing.
 */
describe('the ledger is reconciled against history on every tick', () => {
  /** A transcript carrying one user turn, in the shape Claude Code writes. */
  function writeTurn(at: number): void {
    const dir = path.join(claudeHome, 'projects', 'some-project');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${SESSION_ID}.jsonl`),
      JSON.stringify({
        type: 'user',
        timestamp: new Date(at).toISOString(),
        message: { role: 'user', content: 'hello' },
      }) + '\n',
      'utf8',
    );
  }

  it('corrects a window the tool invented, and does not act on the invented one', async () => {
    clearTurnCache();
    const now = Date.now();
    // The user started the real window an hour ago. It has four hours to run.
    const humanTurn = now - 60 * 60_000;
    const truth = computeWindow(humanTurn);
    writeTurn(humanTurn);

    // What the tool believed: a window of its own, ending later than the truth.
    await mutateState(() => ({
      ...emptyState(now),
      ledger: {
        currentStart: truth.end,
        currentEnd: truth.end + 4 * 60 * 60_000,
        lastClaimedBoundary: null,
        reservation: null,
        source: 'claim',
      },
    }));

    await tick({ actor: { id: 'd', ownSessionId: null }, resume: async () => false, config });

    const after = readState().ledger;
    expect(after.currentEnd).toBe(truth.end);
    expect(after.currentStart).toBe(truth.start);
    expect(after.source).toBe('computed');
  });

  it('leaves a ledger alone when history agrees with it', async () => {
    clearTurnCache();
    const now = Date.now();
    const humanTurn = now - 60 * 60_000;
    const truth = computeWindow(humanTurn);
    writeTurn(humanTurn);

    await mutateState(() => ({
      ...emptyState(now),
      ledger: {
        currentStart: truth.start,
        currentEnd: truth.end,
        lastClaimedBoundary: null,
        reservation: null,
        source: 'computed',
      },
    }));

    await tick({ actor: { id: 'd', ownSessionId: null }, resume: async () => false, config });

    const after = readState().ledger;
    expect(after.currentEnd).toBe(truth.end);
    expect(after.source).toBe('computed');
  });
});
