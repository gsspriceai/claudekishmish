/**
 * What happens when a PTY cannot be allocated.
 *
 * On macOS, node-pty 1.1.0 loads perfectly and then throws
 * `posix_spawnp failed` from `spawn`, because it ships its `spawn-helper`
 * non-executable in the darwin prebuilds and only the macOS code path execs
 * that helper. Unguarded, that throw escaped a top-level await and killed the
 * process — so installing this tool made every interactive `claude` on macOS
 * die with a stack trace.
 *
 * The guard is on `spawn`, not on `load`, because loading is not the thing that
 * fails.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnPty, type PtySession } from '../src/pty/host.js';
import { rmWhenReleased } from './helpers/rm.js';

let session: PtySession | null = null;
let dir: string | null = null;

afterEach(async () => {
  session?.kill();
  session = null;
  if (dir) await rmWhenReleased(dir);
  dir = null;
});

/** A module that loads fine and refuses to spawn — macOS, exactly. */
const throwsOnSpawn = {
  spawn() {
    throw new Error('posix_spawnp failed.');
  },
};

describe('a PTY that cannot be allocated', () => {
  it('degrades to inherited stdio instead of killing the process', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-ptyfail-'));
    const child = path.join(dir, 'child.mjs');
    fs.writeFileSync(child, 'process.exit(3);');

    // The whole point: this must not throw.
    session = await spawnPty(process.execPath, [child], dir, {}, process.stdin, true, throwsOnSpawn);

    expect(session.pid).toBeGreaterThan(0);
    // Degraded: the child still runs, we just cannot type into it.
    expect(session.canInject).toBe(false);
  });

  it('still reports the child exit code, so the shell is not left hanging', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-ptyfail2-'));
    const child = path.join(dir, 'child.mjs');
    fs.writeFileSync(child, 'process.exit(7);');

    session = await spawnPty(process.execPath, [child], dir, {}, process.stdin, true, throwsOnSpawn);

    const code = await new Promise<number>((resolve) => {
      session!.onExit(resolve);
      setTimeout(() => resolve(-1), 15_000);
    });
    expect(code).toBe(7);
  });

  it('claims a draft in the degraded path, so nothing is ever typed blind', async () => {
    // We do not own the input stream there, so we cannot know whether the user
    // has something half-typed. Saying "draft" keeps us out of the way.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-ptyfail3-'));
    const child = path.join(dir, 'child.mjs');
    fs.writeFileSync(child, 'setTimeout(() => {}, 3000);');

    session = await spawnPty(process.execPath, [child], dir, {}, process.stdin, true, throwsOnSpawn);
    expect(session.hasDraftInput()).toBe(true);
    expect(session.write('anything')).toBe(false);
  });
});
