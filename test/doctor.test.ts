/**
 * `ckm doctor` is the one command a user runs when the tool misbehaves, so a
 * diagnostic that lies is worse than no diagnostic at all.
 *
 * This covers a defect that only ever appeared outside this repository: the pty
 * probe ran `require('node-pty')` inside a `node -e` child, and a `-e` script
 * resolves bare specifiers against its **cwd**. From the repo it found node-pty
 * and reported the truth; from a user's own project — which is the only place
 * an installed copy is ever run — it failed to resolve and the doctor reported
 * a broken pty on machines whose pty was perfectly fine.
 *
 * The test therefore runs the built CLI from an unrelated directory. Running it
 * from the repo root, as every other test did, cannot see this at all.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'dist', 'cli', 'index.js');

let home: string;
let elsewhere: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-doctor-home-'));
  elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-doctor-cwd-'));
});

afterEach(() => {
  for (const dir of [home, elsewhere]) fs.rmSync(dir, { recursive: true, force: true });
});

function runDoctorFrom(cwd: string): string {
  if (!fs.existsSync(cli)) throw new Error('run `npm run build` before the test suite');
  const result = spawnSync(process.execPath, [cli, 'doctor'], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: {
      ...process.env,
      CKM_HOME: home,
      // Stands in for the real binary so the doctor never spends a request.
      // `node --version` exits 0 exactly as `claude --version` would.
      CKM_CLAUDE_BIN: process.execPath,
    },
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function ptyLine(output: string): string {
  const line = output.split('\n').find((l) => l.includes('node-pty'));
  if (!line) throw new Error(`doctor printed no node-pty check:\n${output}`);
  return line;
}

describe('ckm doctor, run from somewhere that is not this repository', () => {
  it('resolves node-pty and reports the machine, not the working directory', () => {
    const line = ptyLine(runDoctorFrom(elsewhere));

    // The precise verdict is machine-dependent — CI's macOS runners genuinely
    // cannot allocate a pty — so what is asserted is that the answer came from
    // probing a pty rather than from failing to find the module.
    expect(line).not.toMatch(/Cannot find module/i);
    expect(line).not.toMatch(/not resolvable/i);
  });

  it('gives the same verdict from the repo root and from anywhere else', () => {
    // The bug was invisible precisely because these two disagreed.
    const fromRepo = ptyLine(runDoctorFrom(repo)).replace(/\s+/g, ' ').trim();
    const fromAway = ptyLine(runDoctorFrom(elsewhere)).replace(/\s+/g, ' ').trim();
    expect(fromAway).toBe(fromRepo);
  });
});
