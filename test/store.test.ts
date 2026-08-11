import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLock, isLockContention, mutateState, readState } from '../src/state/store.js';

const run = promisify(execFile);

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-store-'));
  process.env.CKM_HOME = home;
});

afterEach(() => {
  delete process.env.CKM_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function fileUrl(p: string): string {
  return 'file:///' + path.resolve(p).replace(/\\/g, '/');
}

describe('state store', () => {
  it('returns an empty state when no file exists', () => {
    const s = readState();
    expect(s.version).toBe(1);
    expect(s.sessions).toEqual({});
    expect(s.ledger.currentEnd).toBeNull();
  });

  it('round-trips a mutation', async () => {
    await mutateState((s) => ({ ...s, globalPaused: true }));
    expect(readState().globalPaused).toBe(true);
  });

  it('recovers from a corrupt state file instead of throwing', () => {
    fs.writeFileSync(path.join(home, 'state.json'), '{ this is not json', 'utf8');
    // A corrupt file means "no history", not "crash the supervisor".
    expect(() => readState()).not.toThrow();
    expect(readState().sessions).toEqual({});
  });

  it('sets a corrupt file aside instead of silently discarding it', () => {
    // Starting from empty throws away an active halt and the weekly claim
    // count, and the next tick then spends a request the halt existed to
    // prevent. That must at least be recoverable and visible.
    fs.writeFileSync(path.join(home, 'state.json'), '{ truncated', 'utf8');
    readState();
    expect(fs.existsSync(path.join(home, 'state.json.corrupt'))).toBe(true);
  });

  it('throws on an I/O error rather than pretending the state is empty', () => {
    // EPERM and EBUSY are routine on Windows during the concurrent rename, and
    // under antivirus. Treating one as "no history" inside `updateState` would
    // overwrite the ledger, every session, the weekly cap and an active halt
    // with defaults.
    fs.mkdirSync(path.join(home, 'state.json'));
    expect(() => readState()).toThrow();
  });

  it('backfills fields missing from an older state file', () => {
    fs.writeFileSync(
      path.join(home, 'state.json'),
      JSON.stringify({ version: 1, sessions: {}, ledger: { currentEnd: 123 } }),
      'utf8',
    );
    const s = readState();
    expect(s.weekly).toBeDefined();
    expect(s.halted).toBeNull();
    // A ledger written before reservations existed must still load.
    expect(s.ledger.reservation).toBeNull();
    expect(s.ledger.currentEnd).toBe(123);
  });

  it('reclaims a stale lock left behind by a dead process', async () => {
    const lock = path.join(home, 'state.json.lock');
    fs.writeFileSync(lock, '999999');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);

    await expect(mutateState((s) => ({ ...s, globalPaused: true }))).resolves.toBeUndefined();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('does not block the event loop while waiting for the lock', async () => {
    // A wrapper is pumping a live PTY on this loop. A synchronous spin would
    // freeze the user's terminal for the whole contention window.
    const lock = path.join(home, 'state.json.lock');
    fs.writeFileSync(lock, String(process.pid));

    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const release = setTimeout(() => fs.unlinkSync(lock), 400);

    await mutateState((s) => ({ ...s, globalPaused: true }));
    clearInterval(timer);
    clearTimeout(release);

    expect(ticks).toBeGreaterThan(5);
  });

  /**
   * Genuinely concurrent writers.
   *
   * The previous version of this test ran the writers one after another, so it
   * passed even with the lock stubbed out entirely — it proved nothing. These
   * are launched together and must all survive.
   */
  it('serialises concurrent writers in separate processes', async () => {
    const dist = path.resolve('dist/state/store.js');
    if (!fs.existsSync(dist)) throw new Error('run `npm run build` before the test suite');

    const runner = path.join(home, 'writer.mjs');
    fs.writeFileSync(
      runner,
      [
        `process.env.CKM_HOME = ${JSON.stringify(home)};`,
        `const { mutateState } = await import(${JSON.stringify(fileUrl(dist))});`,
        `const id = 's' + process.argv[2];`,
        `await mutateState((s) => ({ ...s, sessions: { ...s.sessions, [id]: {`,
        `  sessionId: id, pid: 1, procStart: null, cwd: '/', name: id, ptyOwned: false,`,
        `  sessionStatus: null, hasDraftInput: false,`,
        `  supervisedFrom: 0, paused: false, pendingResume: false, resumeCount: 0,`,
        `  limit: null, missedLivenessChecks: 0, registeredAt: 0, updatedAt: 0 } } }));`,
      ].join('\n'),
      'utf8',
    );

    const writers = 8;
    await Promise.all(
      Array.from({ length: writers }, (_, i) => run(process.execPath, [runner, String(i)])),
    );

    const final = readState();
    expect(Object.keys(final.sessions).sort()).toEqual(
      Array.from({ length: writers }, (_, i) => `s${i}`).sort(),
    );
  });
});

/**
 * What counts as "the lock is held".
 *
 * On Windows a delete-pending file — unlinked by another process while a handle
 * is still open — reports EPERM or EACCES rather than EEXIST. Same situation,
 * different name; treating it as fatal threw the caller out of its tick under
 * nothing worse than two writers meeting.
 *
 * Found by CI on `windows-latest / node 22`, not by review. The delete-pending
 * window is a few milliseconds wide and cannot be opened deterministically from
 * a test, so the rule is tested directly rather than pantomimed — and a mutation
 * proves the rule is what the lock actually consults.
 */
describe('isLockContention', () => {
  it('treats the Windows delete-pending codes as contention, not failure', () => {
    for (const code of ['EEXIST', 'EPERM', 'EACCES']) {
      expect(isLockContention(code), code).toBe(true);
    }
  });

  it('still lets a genuine error through', () => {
    // A missing directory or a bad path is not something waiting can fix, and
    // silently retrying it for the whole lock timeout would hide the cause.
    for (const code of ['ENOENT', 'ENOTDIR', 'EROFS', 'EMFILE', undefined]) {
      expect(isLockContention(code), String(code)).toBe(false);
    }
  });
});

/**
 * The retry path, at its call site.
 *
 * The rule above says EPERM is contention; this proves the lock consults it.
 * A version that checked `code !== 'EEXIST'` inline passed every test of the
 * rule while behaving exactly as it did before the fix — the same
 * guard-with-no-caller shape that has now bitten this codebase ten times.
 */
describe('the lock retries a Windows delete-pending open', () => {
  it('waits and succeeds instead of throwing', async () => {
    let attempts = 0;
    const held = await acquireLock(async () => {
      attempts++;
      if (attempts <= 2) {
        // Exactly what Windows reports for a lock another process has unlinked
        // while a handle is still open.
        throw Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM' });
      }
      return {
        async writeFile() {},
        async close() {},
      };
    });

    expect(attempts).toBe(3);
    clearInterval(held.heartbeat);
  });

  it('gives up immediately on an error waiting cannot fix', async () => {
    let attempts = 0;
    await expect(
      acquireLock(async () => {
        attempts++;
        throw Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR' });
      }),
    ).rejects.toThrow(/ENOTDIR/);

    // One attempt, not a ten-second spin that buries the real cause.
    expect(attempts).toBe(1);
  });
});
