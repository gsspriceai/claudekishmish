/**
 * `ckm status` — what the tool believes, and what it will do next.
 *
 * A supervisor that acts while you sleep has to be legible when you wake up.
 * This is the screen that makes it legible.
 */

import { loadConfig } from '../../config/index.js';
import { readState } from '../../state/store.js';
import { msUntilBoundary, nextBoundary } from '../../window/ledger.js';
import { decideClaim, recentIdleClaims, sessionResumable } from '../../window/claimer.js';
import { shimInstalled, shimOnPath } from '../../platform/shell.js';
import { daemonLockPath } from '../../platform/paths.js';
import { pidAlive } from '../../claude/sessions.js';
import fs from 'node:fs';

function clock(ms: number | null): string {
  if (ms === null) return 'unknown';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms <= 0) return 'now';
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function daemonRunning(): number | null {
  try {
    const lock = JSON.parse(fs.readFileSync(daemonLockPath(), 'utf8')) as { pid: number };
    return pidAlive(lock.pid) ? lock.pid : null;
  } catch {
    return null;
  }
}

export function runStatus(): number {
  const config = loadConfig();
  const state = readState();
  const now = Date.now();

  const lines: string[] = [];
  lines.push('claudekishmish');
  lines.push('');

  // --- window ------------------------------------------------------------
  const boundary = nextBoundary(state.ledger);
  lines.push('  Window');
  lines.push(`    current ends   ${clock(state.ledger.currentEnd)}   (${state.ledger.source ?? 'no data'})`);
  lines.push(`    next boundary  ${clock(boundary)}   in ${duration(msUntilBoundary(state.ledger, now, config.boundaryBufferMs))}`);
  lines.push(`    last claimed   ${clock(state.ledger.lastClaimedBoundary)}`);
  lines.push('');

  // --- sessions ----------------------------------------------------------
  const sessions = Object.values(state.sessions);
  lines.push(`  Supervised sessions (${sessions.length})`);
  if (sessions.length === 0) {
    lines.push('    none — start one with `claude` once the shim is installed');
  }
  for (const s of sessions) {
    const eligibility = sessionResumable(s, config, now);
    const flags = [
      s.paused ? 'PAUSED' : null,
      s.pendingResume ? 'pending-resume' : null,
      s.ptyOwned ? null : 'no-pty',
    ].filter(Boolean);
    lines.push(`    ${s.name}  (${s.sessionId.slice(0, 8)})  ${flags.join(' ') || 'ok'}`);
    lines.push(`      cwd     ${s.cwd}`);
    lines.push(`      resumes ${s.resumeCount}/${config.maxResumesPerSession}`);
    if (s.limit) {
      lines.push(`      limit   ${s.limit.kind} — resets ${clock(s.limit.resetAt)}`);
    }
    if (!eligibility.ok && s.pendingResume) {
      lines.push(`      blocked ${eligibility.reason}`);
    }
  }
  lines.push('');

  // --- policy ------------------------------------------------------------
  const idleUsed = recentIdleClaims(state, now).length;
  lines.push('  Policy');
  lines.push(`    auto-continue  ${config.autoContinue ? 'on' : 'off'}`);
  lines.push(`    idle claiming  ${config.idleClaim ? 'on' : 'off'}   (${idleUsed}/${config.maxIdleClaimsPerWeek} used this week)`);
  lines.push(`    automation     ${state.globalPaused ? 'PAUSED (ckm resume --all)' : 'active'}`);
  if (state.weekly.suspendedUntil && now < state.weekly.suspendedUntil) {
    lines.push(`    suspended      until ${clock(state.weekly.suspendedUntil)} (weekly limit)`);
  }
  lines.push('');

  // --- install -----------------------------------------------------------
  const pid = daemonRunning();
  lines.push('  Install');
  lines.push(`    shim           ${shimInstalled() ? (shimOnPath() ? 'installed and on PATH' : 'installed but NOT on PATH') : 'not installed'}`);
  lines.push(`    daemon         ${pid ? `running (pid ${pid})` : 'not running'}`);
  lines.push('');

  // --- next action -------------------------------------------------------
  const decision = decideClaim(state, config, now);
  lines.push(`  Next action    ${decision.action} — ${decision.reason}`);

  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
