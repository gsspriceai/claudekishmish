/**
 * Spawning the `claude` executable safely on every platform.
 *
 * On Windows an npm-global Claude Code install puts `claude`, `claude.cmd` and
 * `claude.ps1` on PATH — and since Node 18.20.2 / 20.12 / 22 (the CVE-2024-27980
 * hardening) `child_process.spawn` **refuses a `.cmd` or `.bat` outright** with
 * a synchronous `EINVAL`. Every non-PTY spawn in this tool went through such a
 * path, so nothing that used `child_process` could run Claude at all.
 *
 * Two defences, in order:
 *   1. prefer the real `claude.exe`, which the npm package ships one directory
 *      down from the shim that PATH finds first;
 *   2. if only a `.cmd` is available, route it through `cmd.exe /d /s /c`.
 */

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';

/** A command that is actually safe to hand to `child_process`. */
export interface Launchable {
  file: string;
  prefixArgs: string[];
}

function isBatch(bin: string): boolean {
  const ext = path.extname(bin).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

/**
 * Turn a resolved `claude` path into something spawnable.
 *
 * Batch files are wrapped rather than executed directly. `/d` skips AutoRun
 * commands from the registry, `/s` fixes cmd's quote-stripping rules, `/c` runs
 * and exits.
 */
export function toLaunchable(bin: string): Launchable {
  if (process.platform === 'win32' && isBatch(bin)) {
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
    return { file: comspec, prefixArgs: ['/d', '/s', '/c', bin] };
  }
  return { file: bin, prefixArgs: [] };
}

/** `spawn`, but never EINVAL on a Windows batch shim. */
export function spawnClaude(bin: string, args: string[], options: SpawnOptions): ChildProcess {
  const { file, prefixArgs } = toLaunchable(bin);
  return spawn(file, [...prefixArgs, ...args], options);
}

/** `spawnSync`, same protection. */
export function spawnClaudeSync(
  bin: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2],
): ReturnType<typeof spawnSync> {
  const { file, prefixArgs } = toLaunchable(bin);
  return spawnSync(file, [...prefixArgs, ...args], options);
}
