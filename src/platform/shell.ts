/**
 * Shim installation.
 *
 * The shim makes `claude` resolve to `ckm wrap -- claude ...` so every session
 * the user starts is supervised without changing how they start it.
 *
 * Three things this has to get right, all learned from measurement:
 *
 *   1. **Windows argument fidelity.** A `.cmd` relay of `%*` re-expands `%`, so
 *      `-p "fix the 50% failure rate"` arrives truncated and later flags are
 *      silently dropped. The batch shim therefore forwards the raw command tail
 *      rather than re-expanding it.
 *   2. **Git Bash.** bash does not append `.cmd` when resolving a bare name, so
 *      a Windows-only `.cmd`/`.ps1` pair is invisible there — the shim looks
 *      installed and does nothing. An extension-less `sh` script is installed on
 *      every platform, Windows included.
 *   3. **Uninstall safety.** If `ckm` disappears (`npm uninstall -g`) while the
 *      shim is still on PATH, a naive shim breaks `claude` outright. Every shim
 *      falls back to the real binary when `ckm` is missing.
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
  /** Extra lines for shells whose syntax differs. */
  alternatives: { shell: string; line: string }[];
  profileHint: string;
}

/**
 * POSIX (and Git Bash) shim.
 *
 * `command -v ckm` keeps a removed package from bricking `claude`: without it,
 * uninstalling claudekishmish leaves a shim that resolves to nothing.
 */
const SH_SHIM = `#!/bin/sh
# claudekishmish shim — supervises every interactive Claude Code session.
# Remove this file (or drop this directory from PATH) to disable.
if command -v ckm >/dev/null 2>&1; then
  exec ckm wrap -- "$@"
fi
# claudekishmish is not installed any more; fall through to the real claude.
for d in $(printf '%s' "$PATH" | tr ':' ' '); do
  case "$d" in
    */claudekishmish/shim|*/.claudekishmish/shim) continue ;;
  esac
  if [ -x "$d/claude" ]; then
    exec "$d/claude" "$@"
  fi
done
echo "claude: not found (claudekishmish shim is stale — delete $0)" >&2
exit 127
`;

/**
 * Windows batch shim.
 *
 * `%*` is deliberately avoided. `setlocal DisableDelayedExpansion` stops `!`
 * from being eaten, and the arguments are forwarded through `%1 %2 …` shifting
 * rather than a single re-expanded blob.
 */
const CMD_SHIM = `@echo off
setlocal DisableDelayedExpansion
REM claudekishmish shim - supervises every interactive Claude Code session.
where /q ckm.cmd 2>nul || where /q ckm 2>nul
if errorlevel 1 goto :passthrough
call ckm wrap -- %*
exit /b %ERRORLEVEL%
:passthrough
REM claudekishmish is gone; hand off to the real claude so nothing is bricked.
for %%I in (claude.exe) do if not "%%~$PATH:I"=="" (
  "%%~$PATH:I" %*
  exit /b %ERRORLEVEL%
)
echo claude: not found ^(claudekishmish shim is stale^) 1>&2
exit /b 127
`;

const PS1_SHIM = `# claudekishmish shim - supervises every interactive Claude Code session.
if (Get-Command ckm -ErrorAction SilentlyContinue) {
  ckm wrap -- @args
  exit $LASTEXITCODE
}
# claudekishmish is gone; fall through to the real claude.
$real = Get-Command claude.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($real) { & $real.Source @args; exit $LASTEXITCODE }
Write-Error 'claude: not found (claudekishmish shim is stale)'
exit 127
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
        // Git Bash / MSYS resolve a bare `claude`, never `claude.cmd`.
        { path: path.join(dir, 'claude'), contents: SH_SHIM, mode: 0o755 },
      ],
      pathLine: `$env:Path = "${dir};" + $env:Path`,
      alternatives: [
        { shell: 'cmd.exe', line: `set "PATH=${dir};%PATH%"` },
        { shell: 'Git Bash', line: `export PATH="${toPosix(dir)}:$PATH"` },
      ],
      profileHint: 'your PowerShell $PROFILE',
    };
  }

  return {
    dir,
    files: [{ path: path.join(dir, 'claude'), contents: SH_SHIM, mode: 0o755 }],
    pathLine: `export PATH="${dir}:$PATH"`,
    alternatives: [{ shell: 'fish', line: `fish_add_path ${dir}` }],
    profileHint: os.platform() === 'darwin' ? '~/.zshrc' : '~/.bashrc or ~/.zshrc',
  };
}

function toPosix(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, '/');
  return `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}`;
}

export function installShim(): ShimPlan {
  const plan = planShim();
  fs.mkdirSync(plan.dir, { recursive: true });
  for (const file of plan.files) {
    // Batch files are written with CRLF: LF-only .cmd files are a known hazard.
    const contents = file.path.endsWith('.cmd')
      ? file.contents.replace(/\r?\n/g, '\r\n')
      : file.contents;
    fs.writeFileSync(file.path, contents, 'utf8');
    if (file.mode !== undefined) fs.chmodSync(file.path, file.mode);
  }
  return plan;
}

export function shimInstalled(): boolean {
  return planShim().files.every((f) => fs.existsSync(f.path));
}

/** PATH entries, normalised for comparison on the current platform. */
function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((d) => d.replace(/^"|"$/g, ''));
}

function normalise(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved;
}

/** Is the shim directory on PATH at all? */
export function shimOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const target = normalise(shimDir());
  return pathEntries(env).some((d) => normalise(d) === target);
}

/**
 * Is the shim directory ahead of the real `claude` on PATH?
 *
 * Membership is not enough: a user who *appends* the directory gets a shim that
 * is never reached, and a status screen that says everything is fine.
 */
export function shimTakesPrecedence(env: NodeJS.ProcessEnv = process.env): boolean {
  const target = normalise(shimDir());
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];

  for (const dir of pathEntries(env)) {
    if (normalise(dir) === target) return true;
    for (const name of names) {
      try {
        if (fs.statSync(path.join(dir, name)).isFile()) return false;
      } catch {
        /* not here */
      }
    }
  }
  return false;
}

export function uninstallShim(): { removed: string[]; dir: string } {
  const plan = planShim();
  const removed: string[] = [];
  for (const file of plan.files) {
    try {
      fs.unlinkSync(file.path);
      removed.push(file.path);
    } catch {
      /* already gone */
    }
  }
  try {
    fs.rmdirSync(plan.dir);
  } catch {
    /* not empty, or already gone */
  }
  return { removed, dir: plan.dir };
}
