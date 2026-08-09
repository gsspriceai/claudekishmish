/**
 * `ckm doctor` — check every assumption the tool depends on.
 *
 * The failure modes of a background supervisor are quiet by nature: it simply
 * does not act, and nobody finds out until a window was missed. This command
 * makes each dependency assert itself out loud.
 */

import fs from 'node:fs';
import { locateClaude } from '../../claude/locate.js';
import { claudeProjectsDir, claudeSessionsDir, ckmHome } from '../../platform/paths.js';
import { liveTerminalSessions, pidAlive } from '../../claude/sessions.js';
import { shimInstalled, shimOnPath, planShim } from '../../platform/shell.js';
import { loadNodePty } from '../../pty/host.js';
import { daemonLockPath } from '../../platform/paths.js';
import { readState } from '../../state/store.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** False when a failure only reduces functionality rather than breaking it. */
  fatal: boolean;
}

export async function runDoctor(): Promise<number> {
  const checks: Check[] = [];

  const claude = locateClaude();
  checks.push({
    name: 'claude binary',
    ok: claude !== null,
    detail: claude ?? 'not found on PATH — install Claude Code',
    fatal: true,
  });

  const sessionsDir = claudeSessionsDir();
  checks.push({
    name: 'session descriptors',
    ok: fs.existsSync(sessionsDir),
    detail: fs.existsSync(sessionsDir)
      ? `${sessionsDir} (${liveTerminalSessions().length} live interactive)`
      : `${sessionsDir} missing — run Claude Code once`,
    fatal: true,
  });

  const projects = claudeProjectsDir();
  checks.push({
    name: 'transcripts readable',
    ok: fs.existsSync(projects),
    detail: fs.existsSync(projects) ? projects : `${projects} missing`,
    fatal: true,
  });

  let writable = true;
  try {
    fs.mkdirSync(ckmHome(), { recursive: true });
    const probe = `${ckmHome()}/.probe`;
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
  } catch {
    writable = false;
  }
  checks.push({
    name: 'state directory writable',
    ok: writable,
    detail: ckmHome(),
    fatal: true,
  });

  const pty = await loadNodePty();
  checks.push({
    name: 'node-pty',
    ok: pty !== null,
    detail: pty
      ? 'available — sessions can be continued in place'
      : 'unavailable — supervision and claiming still work, but a session cannot be continued in its own terminal',
    fatal: false,
  });

  const shim = shimInstalled();
  const onPath = shimOnPath();
  checks.push({
    name: 'shim',
    ok: shim && onPath,
    detail: !shim
      ? 'not installed — run `ckm setup`'
      : onPath
        ? planShim().dir
        : `installed but not on PATH — add: ${planShim().pathLine}`,
    fatal: false,
  });

  let daemonPid: number | null = null;
  try {
    const lock = JSON.parse(fs.readFileSync(daemonLockPath(), 'utf8')) as { pid: number };
    daemonPid = pidAlive(lock.pid) ? lock.pid : null;
  } catch {
    daemonPid = null;
  }
  checks.push({
    name: 'daemon',
    ok: daemonPid !== null,
    detail: daemonPid ? `running (pid ${daemonPid})` : 'not running — boundaries will not be claimed while no terminal is open',
    fatal: false,
  });

  const state = readState();
  checks.push({
    name: 'window ledger',
    ok: state.ledger.currentEnd !== null,
    detail:
      state.ledger.currentEnd !== null
        ? `window ends ${new Date(state.ledger.currentEnd).toLocaleString()} (${state.ledger.source})`
        : 'no window observed yet — this fills in after the first supervised session',
    fatal: false,
  });

  const lines = checks.map((c) => {
    const mark = c.ok ? 'ok  ' : c.fatal ? 'FAIL' : 'warn';
    return `  [${mark}] ${c.name.padEnd(26)} ${c.detail}`;
  });

  const fatals = checks.filter((c) => !c.ok && c.fatal).length;
  process.stdout.write(
    ['claudekishmish doctor', '', ...lines, '', fatals === 0 ? '  No blocking problems.' : `  ${fatals} blocking problem(s).`, ''].join('\n'),
  );
  return fatals === 0 ? 0 : 1;
}
