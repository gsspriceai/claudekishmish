/**
 * Find the real `claude` executable.
 *
 * Two hazards, both confirmed on a real machine:
 *
 *   1. **Self-resolution.** Once the shim is installed, plain `claude` resolves
 *      to us. Comparing PATH entries with a case-sensitive string equality is
 *      not enough — Windows PATH is case-insensitive and admits 8.3 short
 *      names, and macOS is case-insensitive by default. A miss there makes the
 *      shim spawn itself.
 *   2. **Windows batch shims.** An npm-global install puts `claude.cmd` on PATH
 *      and the real `claude.exe` one directory down inside `node_modules`. The
 *      `.cmd` is what PATH finds, and `child_process` refuses to spawn it.
 *      Prefer the executable when we can find it.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ckmHome } from '../platform/paths.js';

/** Windows and macOS resolve paths case-insensitively; Linux does not. */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function samePath(a: string, b: string): boolean {
  let x = path.resolve(a);
  let y = path.resolve(b);
  // Windows PATH entries are sometimes quoted, and may carry a trailing slash.
  x = x.replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
  y = y.replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
  if (CASE_INSENSITIVE) {
    x = x.toLowerCase();
    y = y.toLowerCase();
  }
  if (x === y) return true;
  // 8.3 short names ("SCRATC~1") resolve to the same real path; realpath
  // normalises them when the directory exists.
  try {
    const rx = fs.realpathSync.native(x);
    const ry = fs.realpathSync.native(y);
    return CASE_INSENSITIVE ? rx.toLowerCase() === ry.toLowerCase() : rx === ry;
  } catch {
    return false;
  }
}

/**
 * Executable suffixes worth trying, in preference order.
 *
 * `.exe` first, deliberately: PATHEXT lists `.COM;.EXE;.BAT;.CMD`, but npm's
 * bin directory only contains the `.cmd`, so ordering alone does not save us —
 * see `resolveBatchToExe`.
 */
function candidateNames(base: string): string[] {
  if (process.platform !== 'win32') return [base];
  return [`${base}.exe`, `${base}.com`, `${base}.cmd`, `${base}.bat`, base];
}

function isExecutableFile(p: string): boolean {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Given `<npm-prefix>/claude.cmd`, find the package's own `claude.exe`.
 *
 * npm's batch shim sits beside `node_modules`, and Claude Code ships a real
 * executable at `node_modules/@anthropic-ai/claude-code/bin/claude.exe`.
 */
function resolveBatchToExe(shim: string): string | null {
  if (process.platform !== 'win32') return null;
  const ext = path.extname(shim).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return null;

  const real = path.join(
    path.dirname(shim),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
  return isExecutableFile(real) ? real : null;
}

/** The directory our shim lives in; anything inside it must never be spawned. */
export function shimDir(): string {
  return path.join(ckmHome(), 'shim');
}

/**
 * Is this file one of our own shims?
 *
 * Comparing against `shimDir()` alone is not enough: `CKM_HOME` can differ
 * between the run that installed the shim and the run resolving PATH, and then
 * the shim resolves to itself. Every shim carries this marker in its first few
 * lines, so recognising one does not depend on where it lives.
 */
export function isOurShim(file: string): boolean {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 400);
    return head.includes('claudekishmish shim');
  } catch {
    return false;
  }
}

/** Conventional install locations, for when PATH is minimal (launchd, systemd). */
function wellKnownPaths(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
    ];
  }
  return [
    path.join(home, '.local', 'bin', 'claude'), // Claude Code native installer
    '/opt/homebrew/bin/claude', // Homebrew, Apple Silicon
    '/usr/local/bin/claude', // Homebrew, Intel / manual
    path.join(home, '.npm-global', 'bin', 'claude'),
    '/usr/bin/claude',
  ];
}

/**
 * Resolve the real `claude` binary, or `null` if it is not findable.
 *
 * `CKM_CLAUDE_BIN` overrides everything, which is how a user with an unusual
 * install (nvm, a custom npm prefix) pins it, and how the tests point the
 * supervisor at a fake Claude.
 */
export function locateClaude(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.CKM_CLAUDE_BIN;
  if (override && isExecutableFile(override)) return override;

  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const ourShim = shimDir();

  for (const dir of dirs) {
    if (samePath(dir, ourShim)) continue;
    for (const name of candidateNames('claude')) {
      const candidate = path.join(dir, name);
      if (!isExecutableFile(candidate)) continue;
      // Never hand back something inside our own shim directory, whatever the
      // PATH entry looked like — nor a shim living anywhere else.
      if (samePath(path.dirname(candidate), ourShim)) continue;
      if (isOurShim(candidate)) continue;
      return resolveBatchToExe(candidate) ?? candidate;
    }
  }

  for (const candidate of wellKnownPaths()) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Guard against a shim that resolves back to itself.
 *
 * A boolean "already supervised" flag bounds the damage at depth two on
 * Windows; on POSIX, where the environment is inherited through an `exec`, it
 * does not bound anything. A depth counter fails loudly instead of forking.
 */
export const SUPERVISION_DEPTH_VAR = 'CKM_DEPTH';
export const MAX_SUPERVISION_DEPTH = 2;

export function supervisionDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[SUPERVISION_DEPTH_VAR] ?? '0');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}
