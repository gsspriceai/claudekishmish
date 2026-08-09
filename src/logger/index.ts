/**
 * Append-only audit log.
 *
 * Every automatic action is written here *before* it happens, so a user can
 * always reconstruct what the tool did while they were asleep. Failing to log
 * must never prevent the tool from running, and the log never contains prompts,
 * transcript bodies, or credentials — only the tool's own decisions.
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

export function log(level: LogLevel, event: string, detail?: Record<string, unknown>): void {
  const entry: LogEntry = { at: new Date().toISOString(), level, event };
  if (detail) entry.detail = detail;
  try {
    fs.mkdirSync(ckmHome(), { recursive: true });
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

export function readLog(limit: number): LogEntry[] {
  try {
    const lines = fs.readFileSync(logPath(), 'utf8').trim().split('\n');
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
  } catch {
    return [];
  }
}
