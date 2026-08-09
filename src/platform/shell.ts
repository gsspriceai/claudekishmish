/**
 * Shim installation.
 *
 * The shim makes `claude` resolve to `ckm wrap -- claude ...` so every session
 * the user starts is supervised without changing how they start it. It is
 * installed as a small executable in `~/.claudekishmish/shim`, which the user
 * puts at the front of PATH.
 *
 * `locateClaude()` skips this directory when resolving the real binary, which is
 * what stops the shim from invoking itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { shimDir } from '../claude/locate.js';

export interface ShimPlan {
  dir: string;
  files: { path: string; contents: string; mode?: number }[];
  /** The line the user must add to their shell profile. */
  pathLine: string;
  profileHint: string;
}

const POSIX_SHIM = `#!/bin/sh
# claudekishmish shim — supervises every interactive Claude Code session.
# Remove this file (or drop the directory from PATH) to disable.
exec ckm wrap -- "$@"
`;

const CMD_SHIM = `@echo off
REM claudekishmish shim - supervises every interactive Claude Code session.
ckm wrap -- %*
`;

const PS1_SHIM = `# claudekishmish shim - supervises every interactive Claude Code session.
ckm wrap -- @args
`;

/** What installing the shim would do, without doing it. */
export function planShim(): ShimPlan {
  const dir = shimDir();
  if (process.platform === 'win32') {
    return {
      dir,
      files: [
        { path: path.join(dir, 'claude.cmd'), contents: CMD_SHIM },
        { path: path.join(dir, 'claude.ps1'), contents: PS1_SHIM },
      ],
      pathLine: `$env:Path = "${dir};" + $env:Path`,
      profileHint: 'your PowerShell $PROFILE',
    };
  }
  return {
    dir,
    files: [{ path: path.join(dir, 'claude'), contents: POSIX_SHIM, mode: 0o755 }],
    pathLine: `export PATH="${dir}:$PATH"`,
    profileHint: os.platform() === 'darwin' ? '~/.zshrc' : '~/.bashrc (or ~/.zshrc, ~/.config/fish/config.fish)',
  };
}

export function installShim(): ShimPlan {
  const plan = planShim();
  fs.mkdirSync(plan.dir, { recursive: true });
  for (const file of plan.files) {
    fs.writeFileSync(file.path, file.contents, 'utf8');
    if (file.mode !== undefined) fs.chmodSync(file.path, file.mode);
  }
  return plan;
}

export function shimInstalled(): boolean {
  return planShim().files.every((f) => fs.existsSync(f.path));
}

/** Is the shim directory actually ahead of the real binary on PATH? */
export function shimOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const target = path.resolve(shimDir());
  return dirs.some((d) => path.resolve(d) === target);
}

export function uninstallShim(): void {
  const plan = planShim();
  for (const file of plan.files) {
    try {
      fs.unlinkSync(file.path);
    } catch {
      /* already gone */
    }
  }
}
