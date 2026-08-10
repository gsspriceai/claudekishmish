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

/** Put a helper at an arbitrary layout under the fake package. */
function place(...segments: string[]): string {
  const file = path.join(root, ...segments, 'spawn-helper');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '', 'utf8');
  return file;
}

describe('findSpawnHelper', () => {
  it('finds a source build under build/Release', () => {
    expect(findSpawnHelper(entry, 'darwin', 'arm64')).toBe(helper);
  });

  it('finds a PREBUILT install under prebuilds/<platform>-<arch>', () => {
    // This is the layout macOS actually gets from npm, and searching only
    // build/Release made the repair report "nothing to repair" on the one
    // platform it exists for — while the pty tests skipped themselves green.
    fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });
    const prebuilt = place('prebuilds', 'darwin-arm64');
    expect(findSpawnHelper(entry, 'darwin', 'arm64')).toBe(prebuilt);
  });

  it('does not pick up a prebuild for a different architecture', () => {
    fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });
    place('prebuilds', 'darwin-x64');
    expect(findSpawnHelper(entry, 'darwin', 'arm64')).toBeNull();
  });

  it('prefers a local build over a prebuild, as node-pty does', () => {
    // node-pty loads its binding from the first directory that works, and the
    // helper must come from the same place as the binding beside it.
    place('prebuilds', 'darwin-arm64');
    expect(findSpawnHelper(entry, 'darwin', 'arm64')).toBe(helper);
  });

  it('finds a bundled layout, where the dirs sit beside lib/', () => {
    fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });
    const bundled = place('lib', 'build', 'Release');
    expect(findSpawnHelper(entry, 'darwin', 'arm64')).toBe(bundled);
  });

  it('is null when there is no helper to repair', () => {
    // Reporting "repaired" here would be a lie about the one thing the caller
    // needs to know.
    fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });
    expect(findSpawnHelper(entry, 'darwin', 'arm64')).toBeNull();
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

  it('repairs a PREBUILT macOS install, from a machine that is not macOS', () => {
    // Everything above uses build/Release, which is spelled the same on every
    // platform — so it could not see the repair looking under
    // `prebuilds/win32-x64` while claiming to act as darwin. That is the shape
    // the real bug had: "not-found", reported as nothing being wrong.
    fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });
    place('prebuilds', `darwin-${process.arch}`);

    const ops = fakeOps(0o644);
    expect(repairSpawnHelper(entry, 'darwin', ops)).toBe('repaired');
    expect(ops.mode & 0o111).toBe(0o111);
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
