/**
 * End-to-end: wrap a (fake) Claude Code session, let it hit a usage limit, and
 * confirm the supervisor continues it in place when the boundary opens.
 *
 * This exercises the real PTY host, the real state store, the real transcript
 * reader and the real claim logic. Only Claude itself is substituted — no
 * account, no network, no waiting for an actual five-hour window.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const cli = path.join(repo, 'dist', 'cli', 'index.js');
const fakeClaude = path.join(here, 'fixtures', 'fake-claude.mjs');

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

let ckmHome: string;
let claudeHome: string;
let marker: string;
let child: ChildProcess | null = null;

async function waitFor<T>(
  probe: () => T | null | undefined,
  timeoutMs = 15_000,
  everyMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // A probe that throws simply means "not yet" — the state file may not exist
    // for the first few hundred milliseconds of a wrapped session.
    let value: T | null | undefined;
    try {
      value = probe();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

interface TestState {
  sessions: Record<
    string,
    { pendingResume: boolean; ptyOwned: boolean; resumeCount: number; paused: boolean }
  >;
  ledger: { currentEnd: number | null; lastClaimedBoundary: number | null; source: string | null };
}

/** Returns null until the supervisor has written state for the first time. */
function readState(): TestState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(ckmHome, 'state.json'), 'utf8')) as TestState;
  } catch {
    return null;
  }
}

/** Same, but for the points where the state file is required to exist. */
function requireState(): TestState {
  const state = readState();
  if (!state) throw new Error('state.json has not been written yet');
  return state;
}

beforeEach(() => {
  if (!fs.existsSync(cli)) throw new Error('run `npm run build` before the test suite');
  ckmHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-e2e-'));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-claude-'));
  marker = path.join(ckmHome, 'continued.json');

  fs.writeFileSync(
    path.join(ckmHome, 'config.json'),
    JSON.stringify({
      autoContinue: true,
      idleClaim: false,
      continuationText: 'continue',
      boundaryBufferMs: 0,
      pollIntervalMs: 400,
      maxResumesPerSession: 3,
    }),
    'utf8',
  );
});

afterEach(() => {
  child?.kill();
  child = null;
  fs.rmSync(ckmHome, { recursive: true, force: true });
  fs.rmSync(claudeHome, { recursive: true, force: true });
});

function startWrap(): ChildProcess {
  return spawn(process.execPath, [cli, 'wrap', '--', fakeClaude], {
    cwd: repo,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CKM_HOME: ckmHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      // The "claude" binary is node; the fake script is its only argument.
      CKM_CLAUDE_BIN: process.execPath,
      FAKE_SESSION_ID: SESSION_ID,
      FAKE_MARKER: marker,
      CKM_SUPERVISED: '',
      CKM_INTERNAL: '',
    },
  });
}

describe('wrap → limit → continue', () => {
  it('registers the wrapped session and records the limit', async () => {
    child = startWrap();

    const session = await waitFor(() => {
      return readState()?.sessions[SESSION_ID] ?? null;
    });

    expect(session.ptyOwned).toBe(true);

    // The rate-limit record in the transcript must mark the session as pending.
    const pending = await waitFor(() => {
      const s = readState()?.sessions[SESSION_ID];
      return s?.pendingResume ? s : null;
    });
    expect(pending.pendingResume).toBe(true);

    // And the server-stated reset must be what the ledger trusts.
    expect(requireState().ledger.source).toBe('reset-message');
  });

  it('types the continuation into the live session when the boundary opens', async () => {
    child = startWrap();

    await waitFor(() => (readState()?.sessions[SESSION_ID]?.pendingResume ? true : null));

    // Bring the boundary forward instead of waiting five real hours. Everything
    // downstream of this point is the production path.
    const state = JSON.parse(fs.readFileSync(path.join(ckmHome, 'state.json'), 'utf8'));
    state.ledger.currentEnd = Date.now() - 1_000;
    state.ledger.lastClaimedBoundary = null;
    state.ledger.source = 'computed';
    fs.writeFileSync(path.join(ckmHome, 'state.json'), JSON.stringify(state), 'utf8');

    // The fake session writes this file only if it actually received the text.
    const received = await waitFor(() => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null));
    expect(received).toContain('continue');

    const after = await waitFor(() => {
      const s = readState()?.sessions[SESSION_ID];
      return s && s.resumeCount > 0 ? s : null;
    });
    expect(after.resumeCount).toBe(1);
    // The boundary is now spent and must not be claimed twice.
    expect(requireState().ledger.lastClaimedBoundary).not.toBeNull();
  });

  it('does not continue a paused session', async () => {
    child = startWrap();
    await waitFor(() => (readState()?.sessions[SESSION_ID]?.pendingResume ? true : null));

    const state = JSON.parse(fs.readFileSync(path.join(ckmHome, 'state.json'), 'utf8'));
    state.sessions[SESSION_ID].paused = true;
    state.ledger.currentEnd = Date.now() - 1_000;
    state.ledger.lastClaimedBoundary = null;
    state.ledger.source = 'computed';
    fs.writeFileSync(path.join(ckmHome, 'state.json'), JSON.stringify(state), 'utf8');

    // Give the loop several ticks to (not) act.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(fs.existsSync(marker)).toBe(false);
    expect(requireState().sessions[SESSION_ID]?.resumeCount ?? 0).toBe(0);
  });
});
