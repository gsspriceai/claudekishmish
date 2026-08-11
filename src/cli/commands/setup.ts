/**
 * `ckm setup` and `ckm uninstall`.
 *
 * Nothing here needs admin rights, and the two steps that change the user's
 * environment (putting the shim on PATH, starting the background service) are
 * printed for the user to run rather than executed behind their back.
 */

import { installShim, planShim, shimTakesPrecedence, uninstallShim } from '../../platform/shell.js';
import { removeServiceUnit, writeServiceUnit } from '../../platform/service.js';
import { loadConfig, saveConfig } from '../../config/index.js';
import { locateClaude } from '../../claude/locate.js';
import { spawnClaudeSync } from '../../claude/spawn.js';
import { logInfo } from '../../logger/index.js';

export function runSetup(opts: { noClaim?: boolean } = {}): number {
  const out: string[] = ['claudekishmish setup', ''];

  const claude = locateClaude();
  if (!claude) {
    process.stderr.write(
      'Could not find `claude` on PATH. Install Claude Code first, then re-run `ckm setup`.\n',
    );
    return 1;
  }

  // Prove it can actually be executed, not merely that the file exists.
  const probe = spawnClaudeSync(claude, ['--version'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  if (probe.status !== 0) {
    process.stderr.write(
      `Found ${claude} but could not run it: ${probe.error?.message ?? `exit ${probe.status}`}\n` +
        'Set CKM_CLAUDE_BIN to the real executable and re-run `ckm setup`.\n',
    );
    return 1;
  }
  out.push(`  Found Claude Code   ${claude}`);
  out.push(`                      ${`${probe.stdout ?? ''}`.trim().split('\n')[0] ?? ''}`);

  const shim = installShim();
  out.push(`  Installed shim      ${shim.dir}`);

  const service = writeServiceUnit();
  if (service.unitPath) out.push(`  Wrote service unit  ${service.unitPath}`);

  // The autostart entry lives at a fixed per-user OS location, so a second setup
  // run with a different CKM_HOME silently repoints the first one. Say so.
  if (process.env.CKM_HOME) {
    out.push('');
    out.push(`  Note: CKM_HOME is set to ${process.env.CKM_HOME}.`);
    out.push('        The autostart entry is per-user and has been pointed at it,');
    out.push('        replacing any previous one.');
  }

  if (opts.noClaim) {
    saveConfig({ ...loadConfig(), idleClaim: false });
  }
  const config = loadConfig();

  out.push('');
  out.push('  Two steps left — run these yourself:');
  out.push('');
  if (!shimTakesPrecedence()) {
    out.push(`  1. Put the shim FIRST on PATH — ${shim.profileHint}:`);
    out.push('');
    out.push(`         ${shim.pathLine}`);
    out.push('');
    for (const alt of shim.alternatives) {
      out.push(`     ${alt.shell}:`);
      out.push(`         ${alt.line}`);
    }
    out.push('');
  } else {
    out.push('  1. Shim is already first on PATH.');
    out.push('');
  }
  out.push('  2. Start the background claimer:');
  out.push('');
  out.push(`         ${service.activate.join(' ')}`);
  out.push('');
  if (service.notes) out.push(`     ${service.notes}`);
  out.push('');
  out.push('  Then open a new terminal and run `ckm status`.');
  out.push('');
  out.push(`  Both jobs are ON:`);
  out.push(`    auto-continue   ${config.autoContinue ? 'ON ' : 'off'}  continue interrupted work in its own terminal`);
  out.push(`    window claiming ${config.idleClaim ? 'ON ' : 'off'}  keep the 5-hour countdown running`);
  out.push('');
  if (config.idleClaim) {
    // Spending quota with no task behind it must never be a surprise.
    out.push('  Window claiming sends a real request at each boundary, so it does');
    out.push(`  cost you: roughly 22k cached tokens (~$0.02) per claim, capped at`);
    out.push(`  ${config.maxIdleClaimsPerWeek} a week, and suspended automatically if you hit a weekly limit.`);
    out.push('  Turn it off with `ckm claim off`. Every claim is in `ckm logs`.');
    out.push('');
  }
  out.push('  To undo everything: `ckm uninstall`');

  logInfo('setup.completed', { shimDir: shim.dir, service: service.kind });
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

/**
 * Remove the shim and the service unit.
 *
 * This exists because the alternative is worse than untidy: a shim left on PATH
 * after `npm uninstall -g` would intercept `claude` with nothing behind it. (The
 * shims themselves also fall through to the real binary for exactly that case,
 * but the user should still have a clean way out.)
 */
export function runUninstall(): number {
  const { removed, dir } = uninstallShim();
  const unit = removeServiceUnit();
  const plan = planShim();

  const out: string[] = ['claudekishmish uninstall', ''];
  out.push(removed.length > 0 ? `  Removed shim        ${dir}` : '  Shim                already absent');
  out.push(unit ? `  Removed service     ${unit}` : '  Service unit        already absent');
  out.push('');
  out.push('  Still to do by hand:');
  out.push('    - take the shim back off PATH:');
  out.push(`          ${plan.pathRemoval}`);
  if (process.platform === 'linux') {
    out.push('    - systemctl --user disable --now claudekishmish.service');
  }
  if (process.platform === 'darwin') {
    out.push('    - launchctl bootout gui/$UID/com.claudekishmish.daemon');
  }
  out.push('');
  out.push('  Your state and logs are untouched. Delete them with:');
  out.push(
    process.platform === 'win32'
      ? `      Remove-Item -Recurse -Force "${dirOf(dir)}"`
      : `      rm -rf ${dirOf(dir)}`,
  );
  out.push('');

  logInfo('uninstall.completed', { removed: removed.length, unit });
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

function dirOf(shimDirPath: string): string {
  return shimDirPath.replace(/[\\/]shim$/, '');
}

/** `ckm shim` for users who would rather wire PATH themselves. */
export function runShimInfo(): number {
  const plan = planShim();
  const lines = [
    `shim directory : ${plan.dir}`,
    `first on PATH  : ${shimTakesPrecedence() ? 'yes' : 'no'}`,
    `PATH line      : ${plan.pathLine}`,
    `profile        : ${plan.profileHint}`,
  ];
  for (const alt of plan.alternatives) lines.push(`${alt.shell.padEnd(15)}: ${alt.line}`);
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
