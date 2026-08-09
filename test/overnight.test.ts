/**
 * The overnight path: nobody is at the machine, no session is open, a boundary
 * arrives, and the countdown has to keep running anyway.
 *
 * This is the scenario the daemon exists for, and it had no test — it had been
 * observed working live exactly once. The two things that must hold:
 *
 *   1. with no sessions open, nothing tries to resume (there is nothing to
 *      continue, and attempting it would be wrong);
 *   2. the claim opens a **real, persisted session**, so the window it starts is
 *      visible to the ledger afterwards. A claim that persisted nothing would
 *      open a window that nothing on the machine could see — which is precisely
 *      the case here, since no other session is running to leave a trace.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, type Config } from '../src/config/index.js';
import { emptyState } from '../src/state/schema.js';
import { WINDOW_MS, deriveLedgerFromTurns, floor10 } from '../src/window/ledger.js';
import { tick } from '../src/supervisor/index.js';
import { mutateState, readState } from '../src/state/store.js';
import { allUserTurnTimes } from '../src/claude/transcript.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeScript = path.join(here, 'fixtures', 'fake-claude-ping.mjs');

let ckmHome: string;
let claudeHome: string;
let argsFile: string;
let fakeBin: string;

const config: Config = { ...DEFAULT_CONFIG, boundaryBufferMs: 0, idleClaim: true };

beforeEach(() => {
  ckmHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-night-'));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-night-claude-'));
  argsFile = path.join(ckmHome, 'invoked-with.json');
  process.env.CKM_HOME = ckmHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.FAKE_ARGS_FILE = argsFile;

  // A launcher that `spawnClaude` will accept. On Windows this is a .cmd, which
  // also exercises the batch-shim routing that child_process refuses directly.
  if (process.platform === 'win32') {
    fakeBin = path.join(ckmHome, 'fake-claude.cmd');
    fs.writeFileSync(fakeBin, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`, 'utf8');
  } else {
    fakeBin = path.join(ckmHome, 'fake-claude');
    fs.writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, 'utf8');
    fs.chmodSync(fakeBin, 0o755);
  }
  process.env.CKM_CLAUDE_BIN = fakeBin;
});

afterEach(() => {
  for (const k of ['CKM_HOME', 'CLAUDE_CONFIG_DIR', 'FAKE_ARGS_FILE', 'CKM_CLAUDE_BIN']) {
    delete process.env[k];
  }
  fs.rmSync(ckmHome, { recursive: true, force: true });
  fs.rmSync(claudeHome, { recursive: true, force: true });
});

/** A window that has just expired, with nobody around. */
async function seedExpiredWindow(): Promise<number> {
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
  return boundary;
}

describe('nobody is at the machine', () => {
  it('claims the boundary by starting a new session', async () => {
    const boundary = await seedExpiredWindow();
    expect(Object.keys(readState().sessions)).toHaveLength(0);

    let resumeCalled = false;
    const decision = await tick({
      actor: { id: 'daemon-1', ownSessionId: null },
      resume: async () => {
        resumeCalled = true;
        return true;
      },
      config,
    });

    // Nothing to continue, so continuation must not even be attempted.
    expect(decision.action).toBe('ping');
    expect(resumeCalled).toBe(false);

    const after = readState();
    expect(after.ledger.lastClaimedBoundary).toBe(boundary);
    expect(after.ledger.source).toBe('claim');
    expect(after.weekly.idleClaims).toHaveLength(1);
    expect(after.halted).toBeNull();
  });

  it('the claim leaves a real session behind, visible to the ledger', async () => {
    await seedExpiredWindow();
    expect(allUserTurnTimes(path.join(claudeHome, 'projects'))).toHaveLength(0);

    await tick({ actor: { id: 'd', ownSessionId: null }, resume: async () => false, config });

    // One persisted session, one timestamped user turn — enough for a restarted
    // daemon to rediscover the window it just opened.
    const turns = allUserTurnTimes(path.join(claudeHome, 'projects'));
    expect(turns).toHaveLength(1);

    const derived = deriveLedgerFromTurns(turns)!;
    expect(derived.start).toBe(floor10(turns[0]!));
    expect(derived.end - derived.start).toBe(WINDOW_MS);
    // What the transcripts say and what we recorded must agree.
    expect(derived.end).toBe(readState().ledger.currentEnd);
  });

  it('sends the auth-preserving flag set, and persists the session', async () => {
    await seedExpiredWindow();
    await tick({ actor: { id: 'd', ownSessionId: null }, resume: async () => false, config });

    const args = JSON.parse(fs.readFileSync(argsFile, 'utf8')) as string[];
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('-p');
    // The two flags that each broke this feature once.
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--no-session-persistence');
  });

  it('does not claim the same boundary twice', async () => {
    await seedExpiredWindow();
    const run = () => tick({ actor: { id: 'd', ownSessionId: null }, resume: async () => false, config });

    await run();
    const claims = readState().weekly.idleClaims.length;
    await run();
    expect(readState().weekly.idleClaims).toHaveLength(claims);
  });

  it('respects a global pause even with nobody watching', async () => {
    await seedExpiredWindow();
    await mutateState((s) => ({ ...s, globalPaused: true }));

    const decision = await tick({
      actor: { id: 'd', ownSessionId: null },
      resume: async () => false,
      config,
    });

    expect(decision.action).toBe('none');
    expect(fs.existsSync(argsFile)).toBe(false);
    expect(readState().ledger.lastClaimedBoundary).toBeNull();
  });

  it('does not claim when the weekly cap is spent', async () => {
    await seedExpiredWindow();
    const now = Date.now();
    await mutateState((s) => ({
      ...s,
      weekly: { suspendedUntil: null, idleClaims: Array.from({ length: 14 }, (_, i) => now - i * 1000) },
    }));

    const decision = await tick({
      actor: { id: 'd', ownSessionId: null },
      resume: async () => false,
      config,
    });

    expect(decision.action).toBe('none');
    expect(fs.existsSync(argsFile)).toBe(false);
  });
});
