#!/usr/bin/env node
/**
 * claudekishmish CLI.
 *
 * Two jobs:
 *   1. keep a usage window always running by claiming boundaries that would
 *      otherwise pass unclaimed;
 *   2. continue interrupted work in the terminal it was interrupted in.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { runWrap } from './commands/wrap.js';
import { runDaemon } from './commands/daemon.js';
import { runStatus } from './commands/status.js';
import { runPause, runResume } from './commands/pause.js';
import { runSetup, runShimInfo, runUninstall } from './commands/setup.js';
import { runDoctor } from './commands/doctor.js';
import { readLog } from '../logger/index.js';
import {
  coerceConfigValue,
  configKeys,
  loadConfig,
  saveConfig,
  type Config,
} from '../config/index.js';

/** Single source of truth for the version, so it cannot drift. */
function version(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(here, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const program = new Command();

program
  .name('ckm')
  .description('Keep a Claude Code usage window running, and continue interrupted work in place.')
  .version(version());

program
  .command('setup')
  .description('install the shim and write the background service unit')
  .option('--no-claim', 'set up without window claiming (it is on by default)')
  .action((opts: { claim?: boolean }) => {
    // commander maps --no-claim to claim === false
    process.exitCode = runSetup({ noClaim: opts.claim === false });
  });

program
  .command('uninstall')
  .description('remove the shim and the service unit')
  .action(() => {
    process.exitCode = runUninstall();
  });

program
  .command('status')
  .description('show windows, boundaries, supervised sessions and the next action')
  .action(() => {
    process.exitCode = runStatus();
  });

program
  .command('pause')
  .description('stop auto-continuing (this session by default)')
  .option('--all', 'pause everything, including boundary claiming')
  .option('--session <id>', 'target a specific session id')
  .action(async (opts: { all?: boolean; session?: string }) => {
    process.exitCode = await runPause(opts);
  });

program
  .command('resume')
  .description('re-enable after a pause, and clear a halt')
  .option('--all', 'resume everything')
  .option('--session <id>', 'target a specific session id')
  .action(async (opts: { all?: boolean; session?: string }) => {
    process.exitCode = await runResume(opts);
  });

program
  .command('claim')
  .argument('<state>', 'on or off')
  .description('turn idle boundary claiming on or off')
  .action((state: string) => {
    const on = ['on', 'true', '1', 'yes'].includes(state.toLowerCase());
    const off = ['off', 'false', '0', 'no'].includes(state.toLowerCase());
    if (!on && !off) {
      process.stderr.write('Usage: ckm claim on|off\n');
      process.exitCode = 1;
      return;
    }
    saveConfig({ ...loadConfig(), idleClaim: on });
    process.stdout.write(
      on
        ? 'Idle claiming ON. A minimal request will be sent at boundaries with no pending work.\n'
        : 'Idle claiming OFF.\n',
    );
  });

program
  .command('doctor')
  .description('check every dependency the tool relies on')
  .action(async () => {
    process.exitCode = await runDoctor();
  });

program
  .command('logs')
  .description('show the audit log')
  .option('-n, --lines <count>', 'how many entries', '40')
  .action((opts: { lines: string }) => {
    const entries = readLog(Number(opts.lines) || 40);
    if (entries.length === 0) {
      process.stdout.write('No log entries yet.\n');
      return;
    }
    for (const e of entries) {
      const detail = e.detail ? ' ' + JSON.stringify(e.detail) : '';
      process.stdout.write(`${e.at}  ${e.level.padEnd(6)} ${e.event}${detail}\n`);
    }
  });

const config = program.command('config').description('read or change settings');

config
  .command('get [key]')
  .description('print one setting, or all of them')
  .action((key?: string) => {
    const current = loadConfig();
    if (!key) {
      process.stdout.write(JSON.stringify(current, null, 2) + '\n');
      return;
    }
    if (!configKeys().includes(key as keyof Config)) {
      process.stderr.write(`Unknown key "${key}". Known: ${configKeys().join(', ')}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(String(current[key as keyof Config]) + '\n');
  });

config
  .command('set <key> <value>')
  .description('change a setting')
  .action((key: string, value: string) => {
    if (!configKeys().includes(key as keyof Config)) {
      process.stderr.write(`Unknown key "${key}". Known: ${configKeys().join(', ')}\n`);
      process.exitCode = 1;
      return;
    }
    try {
      const coerced = coerceConfigValue(key as keyof Config, value);
      saveConfig({ ...loadConfig(), [key]: coerced });
      process.stdout.write(`${key} = ${String(coerced)}\n`);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command('shim')
  .description('print where the shim lives and how to put it on PATH')
  .action(() => {
    process.exitCode = runShimInfo();
  });

program
  .command('wrap')
  .description('internal: run Claude Code under supervision (this is what the shim calls)')
  .allowUnknownOption(true)
  .argument('[args...]', 'arguments passed through to claude')
  .action(async (args: string[]) => {
    const code = await runWrap(args ?? []);
    // node-pty leaves live handles behind, so a natural exit never arrives and
    // the user's terminal would hang after quitting Claude Code. Leave
    // deliberately, with the child's own exit code.
    process.stdout.write('');
    process.exit(code);
  });

program
  .command('daemon')
  .description('internal: background boundary claimer')
  .option('--once', 'run a single tick and exit (used by tests)')
  .action(async (opts: { once?: boolean }) => {
    process.exitCode = await runDaemon(opts);
  });

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`claudekishmish: ${err.message}\n`);
  process.exitCode = 1;
});
