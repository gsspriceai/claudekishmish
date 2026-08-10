/**
 * Make node-pty usable on macOS.
 *
 * Only the darwin code path in node-pty execs a small setuid-style binary,
 * `build/Release/spawn-helper`, to hand the child its controlling terminal. In
 * several published tarballs that file arrives without its executable bit —
 * npm does not preserve the mode reliably — and `pty.spawn` then throws
 * `posix_spawnp failed.` with nothing to say about why.
 *
 * The observable result is severe and completely silent about its cause: the
 * module imports perfectly, so every "is node-pty installed" check says yes,
 * while in-place continuation is dead on the platform. That is one of this
 * tool's two jobs gone on a third of its users' machines.
 *
 * So the bit is restored rather than worked around. This is a repair to a
 * dependency's own file, of a property that file was published with and lost in
 * transit — not a change of its behaviour.
 *
 * Everything here fails soft. A global install under a root-owned prefix will
 * refuse the chmod, and that is a reason to fall back to a degraded session,
 * never a reason to take down the user's `claude`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { logInfo, logWarn } from '../logger/index.js';

/** Owner/group/other execute. */
const EXEC_BITS = 0o111;

/**
 * Walk up from node-pty's entry point to the directory holding its build
 * output. Resolved rather than assumed: the entry is `lib/index.js` today, but
 * the layout is the dependency's to change, and a hard-coded `'..'` would fail
 * silently — reporting a repaired helper that was never touched.
 */
export function findSpawnHelper(entry: string): string | null {
  let dir = path.dirname(path.resolve(entry));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'build', 'Release', 'spawn-helper');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export type RepairOutcome =
  | 'not-darwin'
  | 'not-found'
  | 'already-executable'
  | 'repaired'
  | 'failed';

/** The two filesystem calls, injectable so the refusal path can be tested. */
export interface ModeOps {
  stat(file: string): { mode: number };
  chmod(file: string, mode: number): void;
}

const realOps: ModeOps = {
  stat: (file) => fs.statSync(file),
  chmod: (file, mode) => fs.chmodSync(file, mode),
};

/**
 * @param platform  injected so the darwin-only path is testable off darwin.
 * @param ops       injected so the refusal path — a global install under a
 *                  root-owned prefix — can be tested without being root.
 */
export function repairSpawnHelper(
  entry: string,
  platform: string = process.platform,
  ops: ModeOps = realOps,
): RepairOutcome {
  if (platform !== 'darwin') return 'not-darwin';

  const helper = findSpawnHelper(entry);
  if (helper === null) {
    // Not every node-pty build has one — a source build may place it elsewhere.
    // Nothing to repair, and nothing worth warning about.
    return 'not-found';
  }

  try {
    const mode = ops.stat(helper).mode;
    if ((mode & EXEC_BITS) !== 0) return 'already-executable';

    ops.chmod(helper, (mode | EXEC_BITS) & 0o7777);
    logInfo('pty.spawn_helper_repaired', {
      helper,
      note: 'restored the executable bit npm dropped; in-place continuation works',
    });
    return 'repaired';
  } catch (err) {
    logWarn('pty.spawn_helper_unrepairable', {
      helper,
      message: (err as Error).message,
      note: 'in-place continuation will be unavailable; boundary claiming is unaffected',
    });
    return 'failed';
  }
}

/** Resolve node-pty from *this* package and repair it. Never throws. */
export function repairInstalledSpawnHelper(platform: string = process.platform): RepairOutcome {
  if (platform !== 'darwin') return 'not-darwin';
  try {
    const entry = createRequire(import.meta.url).resolve('node-pty');
    return repairSpawnHelper(entry, platform);
  } catch {
    return 'not-found';
  }
}
