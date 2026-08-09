/**
 * `ckm setup` — one command to get running, and it tells you exactly what it did.
 *
 * Nothing here is silent and nothing here needs admin rights. The two steps that
 * change the user's environment (adding the shim to PATH, activating the
 * background service) are printed for the user to run, not executed behind their
 * back.
 */

import { installShim, planShim, shimOnPath } from '../../platform/shell.js';
import { planService, writeServiceUnit } from '../../platform/service.js';
import { loadConfig, saveConfig } from '../../config/index.js';
import { locateClaude } from '../../claude/locate.js';
import { logInfo } from '../../logger/index.js';

export function runSetup(opts: { claim?: boolean } = {}): number {
  const out: string[] = [];
  out.push('claudekishmish setup');
  out.push('');

  const claude = locateClaude();
  if (!claude) {
    process.stderr.write(
      'Could not find `claude` on PATH. Install Claude Code first, then re-run `ckm setup`.\n',
    );
    return 1;
  }
  out.push(`  Found Claude Code   ${claude}`);

  const shim = installShim();
  out.push(`  Installed shim      ${shim.dir}`);

  const service = writeServiceUnit();
  if (service.unitPath) out.push(`  Wrote service unit  ${service.unitPath}`);

  if (opts.claim) {
    const config = loadConfig();
    saveConfig({ ...config, idleClaim: true });
    out.push('  Idle claiming       enabled');
  }

  out.push('');
  out.push('  Two steps left — run these yourself:');
  out.push('');
  if (!shimOnPath()) {
    out.push(`  1. Put the shim first on PATH. Add to ${shim.profileHint}:`);
    out.push('');
    out.push(`         ${shim.pathLine}`);
    out.push('');
  } else {
    out.push('  1. Shim is already on PATH.');
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
  out.push('  Defaults: auto-continue ON, idle claiming OFF.');
  out.push('  Idle claiming spends quota with no task behind it, so turn it on');
  out.push('  deliberately with `ckm claim on` once you have read what it does.');

  logInfo('setup.completed', { shimDir: shim.dir, service: service.kind });
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

/** `ckm shim --print` for users who would rather wire PATH themselves. */
export function runShimInfo(): number {
  const plan = planShim();
  process.stdout.write(
    [
      `shim directory : ${plan.dir}`,
      `on PATH        : ${shimOnPath() ? 'yes' : 'no'}`,
      `PATH line      : ${plan.pathLine}`,
      `profile        : ${plan.profileHint}`,
      '',
    ].join('\n'),
  );
  return 0;
}
