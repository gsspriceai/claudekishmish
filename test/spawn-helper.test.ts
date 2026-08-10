/**
 * The macOS repair.
 *
 * node-pty imports cleanly on macOS and every `spawn` then throws
 * `posix_spawnp failed.`, because its `spawn-helper` arrives without an
 * executable bit. In-place continuation — one of this tool's two jobs — is
 * therefore dead on macOS, while every "is node-pty installed" check reports
 * success.
 *
 * Platform and the two filesystem calls are injected, so the darwin-only path
 * is exercised on the machine that actually runs these tests. The alternative
 * was a test that skipped everywhere except a macOS CI runner — a test that
 * proves nothing on the machine where the code was written.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSpawnHelper, repairSpawnHelper, type ModeOps } from '../src/pty/spawn-helper.js';
import { loadNodePty } from '../src/pty/host.js';

let root: string;
let entry: string;
let helper: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-nodepty-'));
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'build', 'Release'), { recursive: true });
  entry = path.join(root, 'lib', 'index.js');
  helper = path.join(root, 'build', 'Release', 'spawn-helper');
  fs.writeFileSync(entry, '', 'utf8');
  fs.writeFileSync(helper, '', 'utf8');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A recording stand-in for stat/chmod.
 *
 * Windows has no executable bit — `fs.chmodSync` there can only toggle
 * read-only — so a test that chmod-ed a real file and re-stat-ed it could only
 * ever pass on POSIX. Modelling the two calls keeps the behaviour under test on
 * every platform, and the real calls are covered by the POSIX block below.
 */
function fakeOps(startMode: number): ModeOps & { mode: number; chmods: number } {
  return {
    mode: startMode,
    chmods: 0,
    stat(this: { mode: number }) {
      return { mode: this.mode };
    },
    chmod(this: { mode: number; chmods: number }, _file: string, mode: number) {
      this.mode = mode;
      this.chmods++;
    },
  } as ModeOps & { mode: number; chmods: number };
}

describe('findSpawnHelper', () => {
  it('finds the helper by walking up from the entry point', () => {
    expect(findSpawnHelper(entry)).toBe(helper);
  });

  it('is null when there is no helper to repair', () => {
    // A source build can place it elsewhere. Reporting "repaired" here would be
    // a lie about the one thing the caller needs to know.
    fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });
    expect(findSpawnHelper(entry)).toBeNull();
  });

  it('does not climb indefinitely towards the filesystem root', () => {
    // Left unbounded this would walk out of the package and could "find" an
    // unrelated build directory belonging to something else entirely.
    const deep = path.join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
    fs.mkdirSync(deep, { recursive: true });
    expect(findSpawnHelper(path.join(deep, 'index.js'))).toBeNull();
  });
});

describe('repairSpawnHelper', () => {
  it('adds the executable bit on darwin', () => {
    const ops = fakeOps(0o644);
    expect(repairSpawnHelper(entry, 'darwin', ops)).toBe('repaired');
    expect(ops.mode & 0o111).toBe(0o111);
  });

  it('leaves the read/write bits exactly as the user set them', () => {
    // A blanket 0o755 would widen permissions the user deliberately narrowed.
    const ops = fakeOps(0o640);
    repairSpawnHelper(entry, 'darwin', ops);
    expect(ops.mode & 0o666).toBe(0o640 & 0o666);
  });

  it('does not write at all when the bit is already there', () => {
    const ops = fakeOps(0o755);
    expect(repairSpawnHelper(entry, 'darwin', ops)).toBe('already-executable');
    expect(ops.chmods).toBe(0);
  });

  it('never touches anything off darwin', () => {
    // Only macOS execs the helper, so a chmod elsewhere would be an
    // unexplained write into somebody else's package.
    for (const platform of ['win32', 'linux']) {
      const ops = fakeOps(0o644);
      expect(repairSpawnHelper(entry, platform, ops)).toBe('not-darwin');
      expect(ops.chmods).toBe(0);
    }
  });

  it('reports, rather than throws, when there is no helper', () => {
    fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });
    expect(repairSpawnHelper(entry, 'darwin')).toBe('not-found');
  });

  it('reports, rather than throws, when the chmod is refused', () => {
    // A global install under a root-owned prefix. Degrading to a session that
    // cannot be continued is correct; taking down the user's `claude` is not.
    const refusing: ModeOps = {
      stat: () => ({ mode: 0o644 }),
      chmod: () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      },
    };
    expect(repairSpawnHelper(entry, 'darwin', refusing)).toBe('failed');
  });
});

describe('the repair is wired into the load path', () => {
  it('runs before node-pty is handed to a caller, and only if there is one', async () => {
    // The macOS breakage survived three audits as a *missing call*, not as
    // wrong logic. A repair nobody invokes fixes nothing.
    //
    // Both directions matter, and node-pty is an optional dependency, so which
    // one applies depends on the environment: CI runs this suite a second time
    // with node-pty uninstalled. Repairing a module that is not installed would
    // mean chmod-ing a path guessed from nothing.
    let called = 0;
    const mod = await loadNodePty(() => {
      called++;
    });

    if (mod === null) {
      expect(called, 'nothing to repair when node-pty is absent').toBe(0);
    } else {
      expect(called, 'the repair must run before the module is used').toBe(1);
      expect(typeof mod.spawn).toBe('function');
    }
  });
});

/**
 * The injected ops above prove the logic; this proves the defaults are wired to
 * the real filesystem — the failure that a fully-mocked test cannot see.
 */
describe.skipIf(process.platform === 'win32')(
  'repairSpawnHelper against a real file (skipped on win32: no executable bit)',
  () => {
    it('really does make the helper executable', () => {
      fs.chmodSync(helper, 0o644);
      expect(fs.statSync(helper).mode & 0o111).toBe(0);

      expect(repairSpawnHelper(entry, 'darwin')).toBe('repaired');
      expect(fs.statSync(helper).mode & 0o111).not.toBe(0);
    });
  },
);
