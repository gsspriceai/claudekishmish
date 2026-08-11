/**
 * Shim installation.
 *
 * The shim makes `claude` resolve to `ckm wrap -- claude ...` so every session
 * the user starts is supervised without changing how they start it.
 *
 * Three things this has to get right, all learned from measurement:
 *
 *   1. **Windows argument fidelity.** Measured, not assumed: `%*` is innocent,
 *      but `call` performs a *second* percent and caret expansion pass. With
 *      `call ckm wrap -- %*`, typing `-p "fix the 50% failure rate"` delivered
 *      `-p "fix the 50 failure rate"` and dropped the flags after it. So the
 *      batch shim invokes `node` and the CLI script directly — no `call`, and no
 *      second batch file in the chain to need one.
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
import { cliEntryPath } from './service.js';

export interface ShimPlan {
  dir: string;
  files: { path: string; contents: string; mode?: number }[];
  /** The one thing to run, or add to a profile, to put the shim on PATH. */
  pathLine: string;
  /** Extra lines for shells whose syntax differs, or shorter-lived options. */
  alternatives: { shell: string; line: string }[];
  /** Where `pathLine` goes, or how long it lasts. Shown next to it. */
  profileHint: string;
  /** How to undo `pathLine`, for `ckm uninstall`. */
  pathRemoval: string;
}

/**
 * POSIX (and Git Bash) shim.
 *
 * `command -v ckm` keeps a removed package from bricking `claude`: without it,
 * uninstalling claudekishmish leaves a shim that resolves to nothing.
 */
const SH_MARKER = 'claudekishmish shim';

const SH_SHIM = `#!/bin/sh
# ${SH_MARKER} — supervises every interactive Claude Code session.
# Remove this file (or drop this directory from PATH) to disable.
if command -v ckm >/dev/null 2>&1; then
  exec ckm wrap -- "$@"
fi
# claudekishmish is not installed any more; fall through to the real claude.
# IFS, not word splitting on spaces: a PATH entry like /c/Program Files/nodejs
# would otherwise be torn into two directories that do not exist.
OLD_IFS="$IFS"
IFS=:
for d in $PATH; do
  IFS="$OLD_IFS"
  [ -x "$d/claude" ] || { IFS=:; continue; }
  # Never exec another copy of ourselves, whatever the directory is called.
  if head -n 3 "$d/claude" 2>/dev/null | grep -q '${SH_MARKER}'; then
    IFS=:
    continue
  fi
  exec "$d/claude" "$@"
done
IFS="$OLD_IFS"
echo "claude: not found (claudekishmish shim is stale — delete $0)" >&2
exit 127
`;

function cmdShim(node: string, cli: string): string {
  // `call` is deliberately absent: it re-expands % and ^ in the forwarded
  // arguments, silently truncating prompts. Invoking node directly avoids
  // needing it at all, because there is no second batch file in the chain.
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'REM claudekishmish shim - supervises every interactive Claude Code session.',
    `if exist "${node}" if exist "${cli}" (`,
    `  "${node}" "${cli}" wrap -- %*`,
    '  exit /b %ERRORLEVEL%',
    ')',
    'REM claudekishmish is gone; hand off to the real claude so nothing is bricked.',
    'for %%I in (claude.exe) do if not "%%~$PATH:I"=="" (',
    '  "%%~$PATH:I" %*',
    '  exit /b %ERRORLEVEL%',
    ')',
    'echo claude: not found ^(claudekishmish shim is stale^) 1>&2',
    'exit /b 127',
    '',
  ].join('\r\n');
}

function ps1Shim(node: string, cli: string): string {
  // PowerShell removes a bare `--` when building native argv, so
  // `ckm wrap -- @args` arrived as `ckm wrap @args`: `claude --version` and
  // `--help` were then answered by ckm itself, and a `--` the user typed was
  // swallowed. The CLI accepts the passthrough without a separator, and node is
  // invoked directly so nothing else can re-parse the arguments.
  return [
    '# claudekishmish shim - supervises every interactive Claude Code session.',
    `$node = '${node}'`,
    `$cli  = '${cli}'`,
    'if ((Test-Path $node) -and (Test-Path $cli)) {',
    '  & $node $cli wrap @args',
    '  exit $LASTEXITCODE',
    '}',
    '# claudekishmish is gone; fall through to the real claude.',
    '$real = Get-Command claude.exe -ErrorAction SilentlyContinue | Select-Object -First 1',
    'if ($real) { & $real.Source @args; exit $LASTEXITCODE }',
    "Write-Error 'claude: not found (claudekishmish shim is stale)'",
    'exit 127',
    '',
  ].join('\n');
}

/** What installing the shim would do, without doing it. */
export function planShim(): ShimPlan {
  const dir = shimDir();
  // Absolute, resolved once at install time. The Windows shims invoke node and
  // the CLI script directly rather than going through `ckm.cmd`, because a
  // second batch file in the chain needs `call`, and `call` mangles arguments.
  const node = process.execPath;
  const cli = cliEntryPath();

  if (process.platform === 'win32') {
    return {
      dir,
      files: [
        { path: path.join(dir, 'claude.cmd'), contents: cmdShim(node, cli) },
        { path: path.join(dir, 'claude.ps1'), contents: ps1Shim(node, cli) },
        // Git Bash / MSYS resolve a bare `claude`, never `claude.cmd`.
        { path: path.join(dir, 'claude'), contents: SH_SHIM, mode: 0o755 },
      ],
      // Persistent and shell-independent, on purpose.
      //
      // The obvious line — `$env:Path = "<dir>;" + $env:Path` — lasts until the
      // terminal closes. Pasting it makes `ckm doctor` go green, `claude` gets
      // supervised, and then the next terminal silently has no shim again: the
      // whole in-place-continuation half of the tool is off and nothing says so.
      // Observed on a real install, where it stayed off for days.
      //
      // `[Environment]::SetEnvironmentVariable(..., 'User')` writes the user
      // environment, so every future process gets it — PowerShell, cmd, Git
      // Bash, VS Code, a GUI-launched terminal. `setx` would do the same thing
      // and truncate PATH at 1024 characters, which is how tools like this one
      // become known for destroying people's PATH.
      pathLine: `[Environment]::SetEnvironmentVariable('Path', '${dir};' + [Environment]::GetEnvironmentVariable('Path','User'), 'User')`,
      alternatives: [
        { shell: 'this session only (PowerShell)', line: `$env:Path = "${dir};" + $env:Path` },
        { shell: 'this session only (cmd.exe)', line: `set "PATH=${dir};%PATH%"` },
        { shell: 'this session only (Git Bash)', line: `export PATH="${toPosix(dir)}:$PATH"` },
      ],
      profileHint: 'run it once, then open a new terminal — it persists for every shell',
      pathRemoval:
        `[Environment]::SetEnvironmentVariable('Path', (([Environment]::GetEnvironmentVariable('Path','User') -split ';') | Where-Object { $_ -ne '${dir}' }) -join ';', 'User')`,
    };
  }

  return {
    dir,
    files: [{ path: path.join(dir, 'claude'), contents: SH_SHIM, mode: 0o755 }],
    pathLine: `export PATH="${dir}:$PATH"`,
    alternatives: [{ shell: 'fish', line: `fish_add_path ${dir}` }],
    profileHint: os.platform() === 'darwin' ? 'add it to ~/.zshrc' : 'add it to ~/.bashrc or ~/.zshrc',
    pathRemoval: `remove this line from your shell profile: export PATH="${dir}:$PATH"`,
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
