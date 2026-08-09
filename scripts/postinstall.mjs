/**
 * The install banner.
 *
 * Two things get in the way of simply `console.log`-ing here:
 *
 *   1. npm hides lifecycle-script output unless you pass `--foreground-scripts`,
 *      so anything written to stdout is swallowed on a normal install;
 *   2. `node-pty` runs its own noisy postinstall around ours, which would bury
 *      the line even when output is shown.
 *
 * Writing straight to the terminal device sidesteps both: `CONOUT$` on Windows,
 * `/dev/tty` elsewhere. If there is no terminal (CI, a piped install, a
 * container) the write fails and we fall back to stdout, then give up quietly.
 *
 * This must never fail an install — npm treats a non-zero postinstall as a
 * failed install, and a banner is not worth that. Every path exits 0.
 */

import fs from 'node:fs';

const BANNER = [
  '',
  '  \u001b[1mclaudekishmish\u001b[0m',
  '  Credits to Gantavya Singh Shekhawat',
  '',
  '  Next:  ckm setup',
  '',
].join('\n');

function quiet() {
  return (
    process.env.CI === 'true' ||
    process.env.CKM_NO_BANNER === '1' ||
    process.env.npm_config_loglevel === 'silent' ||
    process.env.npm_config_loglevel === 'error'
  );
}

/** Write past npm's captured stdout, straight to the user's terminal. */
function writeToTerminal(text) {
  const device = process.platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty';
  let fd;
  try {
    fd = fs.openSync(device, 'w');
    fs.writeSync(fd, text);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to close */
      }
    }
  }
}

try {
  if (!quiet()) {
    if (!writeToTerminal(BANNER + '\n')) {
      process.stdout.write(BANNER + '\n');
    }
  }
} catch {
  // Deliberately swallowed — a banner must not break an install.
}

process.exit(0);
