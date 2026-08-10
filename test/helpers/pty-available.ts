/**
 * Can this machine actually allocate a pseudo-terminal?
 *
 * Not the same question as "is node-pty installed". On macOS, node-pty 1.1.0
 * loads perfectly and then throws `posix_spawnp failed`, because it ships its
 * `spawn-helper` non-executable in the darwin prebuilds.
 *
 * Tests needing a real PTY use this to **skip visibly**, rather than assert
 * against a degraded session and fail, and rather than return early — which
 * would let a genuine regression pass as green.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';

function probe(): boolean {
  // Resolved here and passed in as an absolute path. A child started with
  // `-e` resolves bare specifiers against its cwd, so `require('node-pty')`
  // reports "Cannot find module" from anywhere outside this package - which
  // reads exactly like "no pty on this machine" and would skip these tests
  // on every platform.
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve('node-pty');
  } catch {
    return false;
  }

  const script = [
    `const pty = require(${JSON.stringify(entry)});`,
    "const p = pty.spawn(process.execPath, ['-e', '0'], { cols: 80, rows: 24, cwd: require('os').tmpdir() });",
    'p.kill();',
  ].join('\n');

  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
    cwd: os.tmpdir(),
    windowsHide: true,
  });
  return result.status === 0;
}

export const PTY_AVAILABLE = probe();

export const PTY_SKIP_REASON =
  'needs a pty; node-pty loads but cannot spawn here - known on macOS, see README';
