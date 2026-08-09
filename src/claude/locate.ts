/**
 * Find the real `claude` executable.
 *
 * Once the shim is installed, plain `claude` resolves to us. Re-invoking that
 * would recurse forever, so every spawn goes through here: we walk PATH and skip
 * anything that lives inside our own shim directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ckmHome } from '../platform/paths.js';

/** Executable suffixes worth trying, in preference order, per platform. */
function candidateNames(base: string): string[] {
  if (process.platform !== 'win32') return [base];
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return [...exts.map((e) => base + e.toLowerCase()), base];
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

/** The directory our shim lives in; anything inside it must never be spawned. */
export function shimDir(): string {
  return path.join(ckmHome(), 'shim');
}

/**
 * Resolve the real `claude` binary, or `null` if it is not on PATH.
 *
 * `CKM_CLAUDE_BIN` overrides everything, which is how the tests point the
 * supervisor at a fake Claude.
 */
export function locateClaude(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.CKM_CLAUDE_BIN;
  if (override && isExecutableFile(override)) return override;

  const ourShim = path.resolve(shimDir());
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);

  for (const dir of dirs) {
    if (path.resolve(dir) === ourShim) continue;
    for (const name of candidateNames('claude')) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  // Fall back to the conventional global npm location.
  const npmGlobal =
    process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
      : '/usr/local/bin/claude';
  return isExecutableFile(npmGlobal) ? npmGlobal : null;
}
