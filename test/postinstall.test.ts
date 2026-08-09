/**
 * The install banner.
 *
 * The only hard requirement is that it can never fail an install: npm treats a
 * non-zero postinstall as a failed install, and a banner is not worth that. The
 * script must exit 0 under every condition, including ones where it cannot
 * write anywhere at all.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts', 'postinstall.mjs');

function run(env: Record<string, string> = {}): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 15_000,
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '' };
  }
}

describe('postinstall banner', () => {
  it('is shipped in the package', () => {
    expect(fs.existsSync(script)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as {
      files: string[];
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.postinstall).toContain('postinstall.mjs');
    expect(pkg.files).toContain('scripts/postinstall.mjs');
  });

  it('exits 0 so it can never fail an install', () => {
    expect(run().status).toBe(0);
  });

  it('exits 0 even when it is told to stay quiet', () => {
    expect(run({ CKM_NO_BANNER: '1' }).status).toBe(0);
    expect(run({ CI: 'true' }).status).toBe(0);
    expect(run({ npm_config_loglevel: 'silent' }).status).toBe(0);
  });

  it('carries the credit line', () => {
    const source = fs.readFileSync(script, 'utf8');
    expect(source).toContain('Credits to Gantavya Singh Shekhawat');
    expect(source).toContain('ckm setup');
  });

  it('writes to the terminal device rather than npm-captured stdout', () => {
    // npm hides lifecycle output on a normal install, and node-pty's own
    // postinstall would bury it anyway.
    const source = fs.readFileSync(script, 'utf8');
    expect(source).toContain('CONOUT$');
    expect(source).toContain('/dev/tty');
  });

  it('prints nothing to stdout when told to be quiet', () => {
    expect(run({ CKM_NO_BANNER: '1' }).stdout.trim()).toBe('');
  });
});
