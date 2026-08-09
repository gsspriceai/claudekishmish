/**
 * Append-only audit log.
 *
 * Every automatic action is written here *before* it happens, so a user can
 * always reconstruct what the tool did while they were asleep. Failing to log
 * must never prevent the tool from running, and the log never contains prompts,
 * transcript bodies, or credentials — only the tool's own decisions.
 *
 * It rotates: a resident daemon writing a few lines every ten seconds would
 * otherwise grow an unbounded file that `ckm logs` reads in full.
 */

import fs from 'node:fs';
import { logPath, ckmHome } from '../platform/paths.js';

export type LogLevel = 'info' | 'warn' | 'error' | 'action';

export interface LogEntry {
  at: string;
  level: LogLevel;
  event: string;
  detail?: Record<string, unknown>;
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Keep one previous file, so a rotation never loses the recent past outright. */
function rotateIfLarge(): void {
  try {
    if (fs.statSync(logPath()).size < MAX_LOG_BYTES) return;
    fs.renameSync(logPath(), `${logPath()}.1`);
  } catch {
    /* no log yet, or rotation lost a race — either way, keep going */
  }
}

export function log(level: LogLevel, event: string, detail?: Record<string, unknown>): void {
  const entry: LogEntry = { at: new Date().toISOString(), level, event };
  if (detail) entry.detail = detail;
  try {
    fs.mkdirSync(ckmHome(), { recursive: true });
    rotateIfLarge();
    fs.appendFileSync(logPath(), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // A broken log must not take the supervisor down with it.
  }
}

export const logInfo = (event: string, detail?: Record<string, unknown>) =>
  log('info', event, detail);
export const logWarn = (event: string, detail?: Record<string, unknown>) =>
  log('warn', event, detail);
export const logError = (event: string, detail?: Record<string, unknown>) =>
  log('error', event, detail);
/** Use for anything the tool does on the user's behalf without being asked. */
export const logAction = (event: string, detail?: Record<string, unknown>) =>
  log('action', event, detail);

/** Read the tail of the log, spanning a rotation when necessary. */
export function readLog(limit: number): LogEntry[] {
  const lines: string[] = [];
  for (const file of [`${logPath()}.1`, logPath()]) {
    try {
      lines.push(...fs.readFileSync(file, 'utf8').trim().split('\n'));
    } catch {
      /* not present */
    }
  }
  return lines
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l) as LogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is LogEntry => e !== null);
}
