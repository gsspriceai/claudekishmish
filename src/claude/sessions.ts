/**
 * Discover Claude Code sessions that are genuinely open in a terminal.
 *
 * Claude Code writes `~/.claude/sessions/<pid>.json` for every running session,
 * with the same shape on all three platforms. That file is the whole reason the
 * "only sessions open in a terminal" rule is cheap to enforce:
 *
 *     kind === 'interactive'  &&  entrypoint === 'cli'
 *     &&  pid alive  &&  procStart unchanged
 *
 * All four clauses matter, and the check has to be applied at *registration*
 * and at *every* liveness check — not just in a helper that reporting code
 * happens to call. A background agent or an SDK session is not a terminal the
 * user is sitting in front of, and typing into one is exactly the behaviour
 * this tool must never have.
 *
 * The `procStart` clause guards PID reuse: a matching pid with a different
 * start stamp is a different process.
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

/** The one predicate that defines "open in a terminal". */
export function isInteractiveTerminalSession(s: ClaudeSessionFile): boolean {
  return s.kind === 'interactive' && s.entrypoint === 'cli';
}

/**
 * Read every session descriptor.
 *
 * Returns `null` — not `[]` — when the directory itself cannot be read, so a
 * transient failure is distinguishable from "no sessions". Callers that prune
 * state must not treat the two the same.
 */
export function readSessionFiles(dir = claudeSessionsDir()): ClaudeSessionFile[] | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
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
      // A half-written descriptor is normal: Claude Code rewrites these
      // continuously as session status changes.
    }
  }
  return out;
}

/** Sessions that are interactive, CLI-launched, and whose process is still there. */
export function liveTerminalSessions(
  dir = claudeSessionsDir(),
  isAlive: (pid: number) => boolean = pidAlive,
): ClaudeSessionFile[] {
  return (readSessionFiles(dir) ?? []).filter(
    (s) => isInteractiveTerminalSession(s) && isAlive(s.pid),
  );
}

/** Outcome of a liveness check, distinguishing "gone" from "could not tell". */
export type LivenessResult = 'alive' | 'gone' | 'unknown';

/**
 * Is this supervised session still the same live, interactive process?
 *
 * `unknown` is returned when the descriptor could not be read this time round.
 * Descriptors are rewritten constantly, so a single unreadable read is expected
 * and must not unsupervise a live session.
 */
export function checkSessionLiveness(
  sessionId: string,
  procStart: string | null,
  pid: number | null,
  dir = claudeSessionsDir(),
  isAlive: (pid: number) => boolean = pidAlive,
): LivenessResult {
  const files = readSessionFiles(dir);
  if (files === null) return 'unknown';

  const match = files.find((s) => s.sessionId === sessionId);
  if (!match) {
    // The descriptor is removed when the session exits, but it is also briefly
    // absent while being rewritten. If the process we registered is still
    // running, believe the process.
    if (pid !== null && isAlive(pid)) return 'unknown';
    return 'gone';
  }

  if (!isInteractiveTerminalSession(match)) return 'gone';
  if (!isAlive(match.pid)) return 'gone';
  if (procStart && match.procStart && match.procStart !== procStart) return 'gone';
  if (pid !== null && match.pid !== pid) return 'gone';
  return 'alive';
}

/** Convenience boolean for callers that cannot act on `unknown`. */
export function sessionStillRunning(
  sessionId: string,
  procStart: string | null,
  dir = claudeSessionsDir(),
  isAlive: (pid: number) => boolean = pidAlive,
): boolean {
  return checkSessionLiveness(sessionId, procStart, null, dir, isAlive) === 'alive';
}
