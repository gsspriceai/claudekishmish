/**
 * Can this machine actually allocate a pseudo-terminal?
 *
 * Not the same question as "is node-pty installed". On macOS the module loads
 * perfectly and then `spawn` throws `posix_spawnp failed.`, because the darwin
 * prebuild ships its `spawn-helper` without an executable bit.
 *
 * The probe goes through the same repair the real code path does, for two
 * reasons: a probe that skipped the repair would report "no pty" on a machine
 * where ckm works fine, and — worse — it would let the whole PTY suite skip
 * itself into green on the one platform the repair exists for.
 *
 * When the answer is no, the reason is printed. A silent skip on CI is
 * indistinguishable from a passing test.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import { repairSpawnHelper } from '../../src/pty/spawn-helper.js';

function probe(): { ok: boolean; why: string } {
  // Resolved here and passed in as an absolute path. A child started with `-e`
  // resolves bare specifiers against its cwd, so `require('node-pty')` reports
  // "Cannot find module" from anywhere outside this package — which reads
  // exactly like "no pty on this machine" and would skip these tests
  // everywhere.
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve('node-pty');
  } catch {
    return { ok: false, why: 'node-pty is not installed' };
  }

  const repair = repairSpawnHelper(entry);

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

  if (result.status === 0) return { ok: true, why: `spawn-helper: ${repair}` };

  const firstLine =
    `${result.stderr ?? ''}`
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('at ')) ?? `exit ${result.status ?? 'null'}`;

  return { ok: false, why: `${firstLine.slice(0, 160)} (spawn-helper: ${repair})` };
}

const result = probe();

export const PTY_AVAILABLE = result.ok;
export const PTY_SKIP_REASON = `needs a pty — ${result.why}`;

if (!result.ok) {
  // Loud on purpose. Ten tests silently skipping is how a platform-specific
  // break stays green.
  process.stderr.write(`\n[pty] PTY-dependent tests will SKIP: ${result.why}\n\n`);
}
