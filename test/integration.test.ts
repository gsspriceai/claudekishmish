/**
 * End-to-end: wrap a (fake) Claude Code session, let it hit a usage limit, and
 * confirm the supervisor continues it in place when the boundary opens.
 *
 * This exercises the real PTY host, the real state store, the real transcript
 * reader and the real claim logic. Only Claude itself is substituted — no
 * account, no network, no waiting for an actual five-hour window.
 *
 * Where the test has to move time, it does so through the store's own locked
 * API rather than overwriting `state.json` behind the supervisor's back: an
 * unlocked write would be racing the very code under test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mutateState, readState } from '../src/state/store.js';
import type { State } from '../src/state/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const cli = path.join(repo, 'dist', 'cli', 'index.js');
const fakeClaude = path.join(here, 'fixtures', 'fake-claude.mjs');

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

let ckmHome: string;
let claudeHome: string;
let marker: string;
let child: ChildProcess | null = null;

async function waitFor<T>(probe: () => T | null | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value: T | null | undefined;
    try {
      value = probe();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** Bring the boundary and the stated reset forward, so the test runs in seconds. */
async function makeBoundaryDue(): Promise<void> {
  const now = Date.now();
  await mutateState((s: State) => {
    const session = s.sessions[SESSION_ID];
    return {
      ...s,
      ledger: { ...s.ledger, currentEnd: now - 1_000, lastClaimedBoundary: null, reservation: null },
      sessions: session
        ? {
            ...s.sessions,
            [SESSION_ID]: {
              ...session,
              limit: session.limit ? { ...session.limit, resetAt: now - 1_000 } : session.limit,
            },
          }
        : s.sessions,
    };
  });
}

beforeEach(() => {
  if (!fs.existsSync(cli)) throw new Error('run `npm run build` before the test suite');
  ckmHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-e2e-'));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-claude-'));
  marker = path.join(ckmHome, 'continued.json');
  process.env.CKM_HOME = ckmHome;

  fs.writeFileSync(
    path.join(ckmHome, 'config.json'),
    JSON.stringify({
      autoContinue: true,
      idleClaim: false,
      continuationText: 'continue',
      boundaryBufferMs: 0,
      pollIntervalMs: 1_000,
      maxResumesPerSession: 3,
    }),
    'utf8',
  );
});

afterEach(() => {
  child?.kill();
  child = null;
  delete process.env.CKM_HOME;
  fs.rmSync(ckmHome, { recursive: true, force: true });
  fs.rmSync(claudeHome, { recursive: true, force: true });
});

function startWrap(extraEnv: Record<string, string> = {}): ChildProcess {
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
      CKM_INTERNAL: '',
      CKM_DEPTH: '',
      // These tests drive `ckm wrap` over pipes. Without this it would correctly
      // decide the run is non-interactive and skip the PTY — which is the right
      // behaviour for `claude -p > file`, and the wrong one here.
      CKM_FORCE_PTY: '1',
      ...extraEnv,
    },
  });
}

const pending = () => (readState().sessions[SESSION_ID]?.pendingResume ? true : null);

describe('wrap → limit → continue', () => {
  it('registers the session and records the live limit', async () => {
    child = startWrap();

    const session = await waitFor(() => readState().sessions[SESSION_ID] ?? null);
    expect(session.ptyOwned).toBe(true);
    expect(session.supervisedFrom).toBeGreaterThan(0);

    await waitFor(pending);
    expect(readState().ledger.source).toBe('reset-message');
  });

  it('types the continuation into the live session when the boundary opens', async () => {
    child = startWrap();
    await waitFor(pending);
    await makeBoundaryDue();

    const received = await waitFor(() =>
      fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null,
    );
    expect(received).toContain('continue');

    const after = await waitFor(() => {
      const s = readState().sessions[SESSION_ID];
      return s && s.resumeCount > 0 ? s : null;
    });
    expect(after.resumeCount).toBe(1);
    expect(after.pendingResume).toBe(false);
    // The boundary is spent, and only after the text actually landed.
    expect(readState().ledger.lastClaimedBoundary).not.toBeNull();
  });

  it('does not continue a paused session', async () => {
    child = startWrap();
    await waitFor(pending);

    await mutateState((s) => ({
      ...s,
      sessions: { ...s.sessions, [SESSION_ID]: { ...s.sessions[SESSION_ID]!, paused: true } },
    }));
    await makeBoundaryDue();

    await new Promise((r) => setTimeout(r, 4_000));
    expect(fs.existsSync(marker)).toBe(false);
    expect(readState().sessions[SESSION_ID]?.resumeCount ?? 0).toBe(0);
    // And a paused session must not lose the boundary either.
    expect(readState().ledger.lastClaimedBoundary).toBeNull();
  });

  /**
   * The regression test for a confirmed defect: a `rate_limit` record left in a
   * reused transcript made the tool type `continue` about a second after the
   * user opened their session. On the author's own machine, 13 of 14
   * transcripts containing a limit had later user turns.
   */
  it('ignores a limit left over from an earlier run of the same session', async () => {
    child = startWrap({ FAKE_STALE_LIMIT: '1' });

    await waitFor(() => readState().sessions[SESSION_ID] ?? null);
    await new Promise((r) => setTimeout(r, 4_000));

    expect(readState().sessions[SESSION_ID]?.pendingResume ?? false).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  /** A background or SDK session is not a terminal the user is sitting in. */
  it('refuses to supervise a non-interactive session', async () => {
    child = startWrap({ FAKE_KIND: 'background', FAKE_LIMIT_DELAY_MS: '200' });

    await new Promise((r) => setTimeout(r, 5_000));
    expect(readState().sessions[SESSION_ID]).toBeUndefined();
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('wrap lifecycle', () => {
  /**
   * node-pty leaves live handles behind, so without an explicit exit the
   * wrapper never terminates: the user quits Claude Code and their prompt never
   * comes back. The old suite could not see this because it killed the child.
   */
  it('exits by itself when Claude exits, with Claude\'s exit code', async () => {
    child = startWrap();
    await waitFor(() => readState().sessions[SESSION_ID] ?? null);

    const exited = new Promise<number | null>((resolve) => {
      child!.on('exit', (code) => resolve(code));
    });

    // A PTY is line-buffered and Enter is a carriage return, not a newline.
    child.stdin?.write('quit\r');

    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 15_000)),
    ]);

    expect(code).not.toBe('timeout');
    expect(code).toBe(7);
  });

  it('deregisters the session on exit', async () => {
    child = startWrap();
    await waitFor(() => readState().sessions[SESSION_ID] ?? null);
    // A PTY is line-buffered and Enter is a carriage return, not a newline.
    child.stdin?.write('quit\r');
    await waitFor(() => (readState().sessions[SESSION_ID] === undefined ? true : null), 15_000);
  });
});
