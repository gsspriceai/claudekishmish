/**
 * Discover Claude Code sessions that are genuinely open in a terminal.
 *
 * Claude Code writes `~/.claude/sessions/<pid>.json` for every running session,
 * with the same shape on all three platforms. That file is the whole reason the
 * "only sessions open in a terminal" rule is cheap to enforce:
 *
 *     kind === 'interactive'  &&  pid alive  &&  procStart unchanged
 *
 * The `procStart` check matters. PIDs are recycled, and without it a stale
 * descriptor could point us at whatever unrelated process inherited the number.
 */

import fs from 'node:fs';
import path from 'node:path';
import { claudeSessionsDir } from '../platform/paths.js';

export interface ClaudeSessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt?: number;
  procStart?: string;
  version?: string;
  kind?: string;
  entrypoint?: string;
  name?: string;
  status?: string;
  updatedAt?: number;
}

/** Is a PID currently alive? Signal 0 tests existence without touching it. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read every session descriptor, skipping unreadable or malformed files. */
export function readSessionFiles(dir = claudeSessionsDir()): ClaudeSessionFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const out: ClaudeSessionFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      const parsed = JSON.parse(raw) as ClaudeSessionFile;
      if (typeof parsed?.pid === 'number' && typeof parsed?.sessionId === 'string') {
        out.push(parsed);
      }
    } catch {
      // A half-written descriptor is normal during session startup.
    }
  }
  return out;
}

/**
 * Sessions that are interactive, CLI-launched, and whose process is still there.
 *
 * `isAlive` is injectable so tests can exercise liveness without spawning
 * processes.
 */
export function liveTerminalSessions(
  dir = claudeSessionsDir(),
  isAlive: (pid: number) => boolean = pidAlive,
): ClaudeSessionFile[] {
  return readSessionFiles(dir).filter(
    (s) => s.kind === 'interactive' && s.entrypoint === 'cli' && isAlive(s.pid),
  );
}

/**
 * Confirm a previously-registered session is still the same process.
 *
 * Returns false on PID reuse, which is exactly when a naive `pidAlive` check
 * would have returned a dangerous true.
 */
export function sessionStillRunning(
  sessionId: string,
  procStart: string | null,
  dir = claudeSessionsDir(),
  isAlive: (pid: number) => boolean = pidAlive,
): boolean {
  const match = readSessionFiles(dir).find((s) => s.sessionId === sessionId);
  if (!match) return false;
  if (!isAlive(match.pid)) return false;
  if (procStart && match.procStart && match.procStart !== procStart) return false;
  return true;
}
