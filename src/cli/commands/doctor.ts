/**
 * `ckm doctor` — check every assumption the tool depends on.
 *
 * The failure modes of a background supervisor are quiet by nature: it simply
 * does not act, and nobody finds out until a window was missed. This command
 * makes each dependency assert itself out loud.
 *
 * Crucially it **executes** `claude --version` rather than merely stat-ing the
 * file. Statting cannot detect that the resolved path is a Windows batch shim
 * that `child_process` refuses to spawn — which is exactly the failure a doctor
 * exists to catch. `--version` makes no API request, so this costs nothing.
 */

import fs from 'node:fs';
import os from 'node:os';
import { locateClaude } from '../../claude/locate.js';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { spawnClaudeSync } from '../../claude/spawn.js';
import { claudeProjectsDir, claudeSessionsDir, ckmHome, daemonLockPath } from '../../platform/paths.js';
import { liveTerminalSessions, pidAlive } from '../../claude/sessions.js';
import { planShim, shimInstalled, shimOnPath, shimTakesPrecedence } from '../../platform/shell.js';
import { planService } from '../../platform/service.js';
import { loadNodePty } from '../../pty/host.js';
import { readState } from '../../state/store.js';
import { haltAdvice } from '../../claude/failure.js';

/**
 * Can we actually allocate a pseudo-terminal on this machine, right now?
 *
 * Probed by allocating one, not by loading the module. On macOS node-pty loads
 * perfectly and then throws on `spawn`, because it ships its `spawn-helper`
 * non-executable in the darwin prebuilds — so a load-only check reported
 * "available" on the one platform where in-place continuation is completely
 * broken, pointing the user away from the fault in the single command they run
 * when it misbehaves.
 *
 * Run in a child process with its output captured: node-pty spawns a console
 * helper of its own that prints to stderr in some environments, and a
 * diagnostic that emits a stack trace while reporting success is worse than no
 * diagnostic.
 */
async function probePty(): Promise<{ ok: boolean; detail: string }> {
  if (!(await loadNodePty())) {
    return {
      ok: false,
      detail:
        'not installed — supervision and boundary claiming still work, but a session cannot be continued in its own terminal',
    };
  }

  // node-pty resolved to an absolute path *here*, in this package, and passed
  // into the child. A `-e` script resolves bare specifiers against its cwd, so
  // `require('node-pty')` fails for every globally-installed user running
  // `ckm doctor` from their own project - and the doctor would then report a
  // broken pty on machines where the pty is fine.
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve('node-pty');
  } catch {
    return { ok: false, detail: 'installed but not resolvable from this package - reinstall claudekishmish' };
  }

  const script = [
    `const pty = require(${JSON.stringify(entry)});`,
    "const p = pty.spawn(process.execPath, ['-e', '0'], { cols: 80, rows: 24, cwd: require('os').tmpdir() });",
    'p.kill();',
    'process.exit(0);',
  ].join('\n');

  const probe = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
    cwd: os.tmpdir(),
    windowsHide: true,
  });

  if (probe.status === 0) {
    return { ok: true, detail: 'available — sessions can be continued in place' };
  }
  const why = firstLine(`${probe.stderr ?? ''}`) || `exit ${probe.status ?? 'null'}`;
  return {
    ok: false,
    detail: `loads but cannot allocate a pty (${why}) — supervision and claiming still work; in-place continuation does not`,
  };
}

function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length > 0 && !t.startsWith('at ')) return t.slice(0, 120);
  }
  return '';
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** False when a failure only reduces functionality rather than breaking it. */
  fatal: boolean;
}

export async function runDoctor(): Promise<number> {
  const checks: Check[] = [];
  const state = readState();

  if (state.halted) {
    checks.push({
      name: 'halted',
      ok: false,
      detail: `${state.halted.detail} — ${haltAdvice(state.halted.reason)}`,
      fatal: true,
    });
  }

  const claude = locateClaude();
  checks.push({
    name: 'claude binary',
    ok: claude !== null,
    detail: claude ?? 'not found on PATH — install Claude Code, or set CKM_CLAUDE_BIN',
    fatal: true,
  });

  if (claude) {
    // Actually run it. A path that exists is not a path we can spawn.
    const probe = spawnClaudeSync(claude, ['--version'], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    const version = `${probe.stdout ?? ''}`.trim().split('\n')[0] ?? '';
    checks.push({
      name: 'claude is spawnable',
      ok: probe.status === 0,
      detail:
        probe.status === 0
          ? version || 'ok'
          : `cannot execute it: ${probe.error?.message ?? `exit ${probe.status}`}`,
      fatal: true,
    });
  }

  const sessionsDir = claudeSessionsDir();
  const sessionsExist = fs.existsSync(sessionsDir);
  checks.push({
    name: 'session descriptors',
    ok: sessionsExist,
    detail: sessionsExist
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
  checks.push({ name: 'state directory writable', ok: writable, detail: ckmHome(), fatal: true });

  // Probed by allocating one, not by loading the module.
  //
  // On macOS node-pty loads perfectly and then throws on `spawn`, so a
  // load-only check reported "available" on the one platform where in-place
  // continuation is completely broken — pointing the user away from the fault
  // in the single command they run when it misbehaves.
  const ptyProbe = await probePty();
  checks.push({
    name: 'node-pty',
    ok: ptyProbe.ok,
    detail: ptyProbe.detail,
    fatal: false,
  });

  const plan = planShim();
  checks.push({
    name: 'shim',
    ok: shimInstalled() && shimTakesPrecedence(),
    detail: !shimInstalled()
      ? 'not installed — run `ckm setup`'
      : !shimOnPath()
        ? `installed but not on PATH — add: ${plan.pathLine}`
        : !shimTakesPrecedence()
          ? 'on PATH but behind the real claude — move it to the FRONT of PATH or it will never run'
          : plan.dir,
    fatal: false,
  });

  const service = planService();
  checks.push({
    name: 'service unit',
    ok: service.unitPath ? fs.existsSync(service.unitPath) : false,
    detail: service.unitPath
      ? fs.existsSync(service.unitPath)
        ? service.unitPath
        : `not written — run \`ckm setup\``
      : 'no service integration on this platform',
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
    detail: daemonPid
      ? `running (pid ${daemonPid})`
      : 'not running — boundaries will not be claimed while no terminal is open',
    fatal: false,
  });

  checks.push({
    name: 'window ledger',
    ok: state.ledger.currentEnd !== null,
    detail:
      state.ledger.currentEnd !== null
        ? `window ends ${new Date(state.ledger.currentEnd).toLocaleString()} (${state.ledger.source})`
        : 'no window observed yet — the daemon derives one from your history at startup',
    fatal: false,
  });

  const lines = checks.map((c) => {
    const mark = c.ok ? 'ok  ' : c.fatal ? 'FAIL' : 'warn';
    return `  [${mark}] ${c.name.padEnd(26)} ${c.detail}`;
  });

  const fatals = checks.filter((c) => !c.ok && c.fatal).length;
  process.stdout.write(
    [
      'claudekishmish doctor',
      '',
      ...lines,
      '',
      fatals === 0 ? '  No blocking problems.' : `  ${fatals} blocking problem(s).`,
      '',
    ].join('\n'),
  );
  return fatals === 0 ? 0 : 1;
}
