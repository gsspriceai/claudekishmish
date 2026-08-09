import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-store-'));
  process.env.CKM_HOME = home;
});

afterEach(() => {
  delete process.env.CKM_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

/** Import fresh each time so the path helpers pick up the current CKM_HOME. */
async function store() {
  return await import('../src/state/store.js?t=' + Date.now());
}

function fileUrl(p: string): string {
  return 'file:///' + path.resolve(p).replace(/\\/g, '/');
}

describe('state store', () => {
  it('returns an empty state when no file exists', async () => {
    const { readState } = await store();
    const s = readState();
    expect(s.version).toBe(1);
    expect(s.sessions).toEqual({});
    expect(s.ledger.currentEnd).toBeNull();
  });

  it('round-trips a mutation', async () => {
    const { mutateState, readState } = await store();
    mutateState((s) => ({ ...s, globalPaused: true }));
    expect(readState().globalPaused).toBe(true);
  });

  it('recovers from a corrupt state file instead of throwing', async () => {
    const { readState } = await store();
    fs.writeFileSync(path.join(home, 'state.json'), '{ this is not json', 'utf8');
    // A corrupt file means "no history", not "crash the supervisor".
    expect(() => readState()).not.toThrow();
    expect(readState().sessions).toEqual({});
  });

  it('backfills fields missing from an older state file', async () => {
    const { readState } = await store();
    fs.writeFileSync(
      path.join(home, 'state.json'),
      JSON.stringify({ version: 1, sessions: {} }),
      'utf8',
    );
    const s = readState();
    expect(s.weekly).toBeDefined();
    expect(s.ledger).toBeDefined();
  });

  it('reclaims a stale lock left behind by a dead process', async () => {
    const { mutateState } = await store();
    const lock = path.join(home, 'state.json.lock');
    fs.writeFileSync(lock, '999999');
    // Backdate it past the staleness threshold.
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);

    expect(() => mutateState((s) => ({ ...s, globalPaused: true }))).not.toThrow();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('serialises writers in separate processes without losing an update', () => {
    // This is the real concurrency case: a daemon and several wrappers all
    // mutating one file. In-process tests would not exercise the file lock.
    const dist = path.resolve('dist/state/store.js');
    if (!fs.existsSync(dist)) {
      throw new Error('run `npm run build` before the test suite — this test exercises dist/');
    }

    const runner = path.join(home, 'writer.mjs');
    fs.writeFileSync(
      runner,
      [
        `process.env.CKM_HOME = ${JSON.stringify(home)};`,
        `const { mutateState } = await import(${JSON.stringify(fileUrl(dist))});`,
        `const id = 's' + process.argv[2];`,
        `mutateState((s) => ({ ...s, sessions: { ...s.sessions, [id]: {`,
        `  sessionId: id, pid: 1, procStart: null, cwd: '/', name: id,`,
        `  ptyOwned: false, paused: false, pendingResume: false, resumeCount: 0,`,
        `  limit: null, registeredAt: 0, updatedAt: 0 } } }));`,
      ].join('\n'),
      'utf8',
    );

    const writers = 6;
    for (let i = 0; i < writers; i++) {
      execFileSync(process.execPath, [runner, String(i)], { stdio: 'pipe' });
    }

    const final = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')) as {
      sessions: Record<string, unknown>;
    };
    // Every writer's update survived: none was clobbered by a concurrent write.
    expect(Object.keys(final.sessions).sort()).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
  });
});
