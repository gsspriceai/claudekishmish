/**
 * `ckm daemon` — the background boundary claimer.
 *
 * This is the half of the tool that works when no terminal is open at all. It
 * never injects anything; it only claims a boundary that would otherwise pass
 * unclaimed, and only when the user has turned that on.
 */

import fs from 'node:fs';
import { loadConfig } from '../../config/index.js';
import { logError, logInfo } from '../../logger/index.js';
import { daemonLockPath, ckmHome } from '../../platform/paths.js';
import { pidAlive } from '../../claude/sessions.js';
import { tick } from '../../supervisor/index.js';

interface DaemonLock {
  pid: number;
  startedAt: number;
}

/** Claim the single-daemon slot, or report who already holds it. */
export function acquireDaemonSlot(): { ok: boolean; holder?: number } {
  fs.mkdirSync(ckmHome(), { recursive: true });
  try {
    const raw = fs.readFileSync(daemonLockPath(), 'utf8');
    const lock = JSON.parse(raw) as DaemonLock;
    if (lock.pid !== process.pid && pidAlive(lock.pid)) {
      return { ok: false, holder: lock.pid };
    }
  } catch {
    // No lock, or an unreadable one: both mean the slot is free.
  }
  const lock: DaemonLock = { pid: process.pid, startedAt: Date.now() };
  fs.writeFileSync(daemonLockPath(), JSON.stringify(lock, null, 2), 'utf8');
  return { ok: true };
}

export function releaseDaemonSlot(): void {
  try {
    const lock = JSON.parse(fs.readFileSync(daemonLockPath(), 'utf8')) as DaemonLock;
    if (lock.pid === process.pid) fs.unlinkSync(daemonLockPath());
  } catch {
    /* nothing to release */
  }
}

export async function runDaemon(opts: { once?: boolean } = {}): Promise<number> {
  const config = loadConfig();

  const slot = acquireDaemonSlot();
  if (!slot.ok) {
    process.stderr.write(`claudekishmish: daemon already running (pid ${slot.holder}).\n`);
    return 1;
  }

  logInfo('daemon.start', { pid: process.pid, pollIntervalMs: config.pollIntervalMs });

  // The daemon owns no PTY, so it can never resume anything itself.
  const runOnce = () =>
    tick({
      ownSessionId: null,
      resume: async () => false,
      config: loadConfig(),
    }).catch((err: Error) => {
      logError('daemon.tick_failed', { message: err.message });
      return null;
    });

  if (opts.once) {
    await runOnce();
    releaseDaemonSlot();
    return 0;
  }

  const loop = setInterval(() => void runOnce(), config.pollIntervalMs);

  const shutdown = () => {
    clearInterval(loop);
    releaseDaemonSlot();
    logInfo('daemon.stop', {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {
    /* run until signalled */
  });
  return 0;
}
