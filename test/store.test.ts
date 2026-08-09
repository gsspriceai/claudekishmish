import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mutateState, readState } from '../src/state/store.js';

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
