/**
 * Shim resolution and PATH handling.
 *
 * Two confirmed hazards are covered here: a shim that resolves to itself
 * (a fork bomb on POSIX), and a shim that sits *behind* the real binary on PATH
 * while every status screen reports it as installed and working.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let home: string;
let shimDirPath: string;
let realDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-shim-'));
  process.env.CKM_HOME = home;
  shimDirPath = path.join(home, 'shim');
  realDir = path.join(home, 'realbin');
  fs.mkdirSync(realDir, { recursive: true });
});

afterEach(() => {
  delete process.env.CKM_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function shell() {
  return await import('../src/platform/shell.js?t=' + Date.now());
}
async function locate() {
  return await import('../src/claude/locate.js?t=' + Date.now());
}

function realClaudeName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function writeRealClaude(): string {
  const p = path.join(realDir, realClaudeName());
  fs.writeFileSync(p, '#!/bin/sh\necho real\n');
  fs.chmodSync(p, 0o755);
  return p;
}

const sep = path.delimiter;

describe('installShim', () => {
  it('installs an extension-less sh shim on every platform', async () => {
    // Git Bash on Windows resolves a bare `claude` and never `claude.cmd`, so a
    // Windows-only pair is invisible there — installed, on PATH, and inert.
    const { installShim } = await shell();
    installShim();
    expect(fs.existsSync(path.join(shimDirPath, 'claude'))).toBe(true);
    if (process.platform === 'win32') {
      expect(fs.existsSync(path.join(shimDirPath, 'claude.cmd'))).toBe(true);
      expect(fs.existsSync(path.join(shimDirPath, 'claude.ps1'))).toBe(true);
    }
  });

  it('writes batch files with CRLF endings', async () => {
    if (process.platform !== 'win32') return;
    const { installShim } = await shell();
    installShim();
    const raw = fs.readFileSync(path.join(shimDirPath, 'claude.cmd'), 'utf8');
    expect(raw).toContain('\r\n');
  });

  it('every shim falls back to the real claude if the tool is gone', async () => {
    // Otherwise `npm uninstall -g claudekishmish` leaves a shim on PATH that
    // intercepts `claude` with nothing behind it.
    const { installShim } = await shell();
    const plan = installShim();
    for (const file of plan.files) {
      const body = fs.readFileSync(file.path, 'utf8');
      // Each one checks that what it is about to run still exists, and hands off
      // to the real binary when it does not.
      expect(body, file.path).toMatch(/claude/i);
      expect(body, file.path).toMatch(/not found|Test-Path|if exist|command -v/);
    }
    const sh = fs.readFileSync(path.join(shimDirPath, 'claude'), 'utf8');
    expect(sh).toMatch(/command -v ckm/);
  });

  it('the Windows shims invoke node directly, never a second batch file', async () => {
    // `call` re-expands % and ^ in the forwarded arguments, silently truncating
    // prompts, and a batch file calling another batch file needs `call`.
    if (process.platform !== 'win32') return;
    const { installShim } = await shell();
    installShim();

    const cmd = fs.readFileSync(path.join(shimDirPath, 'claude.cmd'), 'utf8');
    expect(cmd).not.toMatch(/call/i);
    expect(cmd).toContain('node');

    // PowerShell strips a bare `--`, so the shim must not depend on one.
    const ps1 = fs.readFileSync(path.join(shimDirPath, 'claude.ps1'), 'utf8');
    expect(ps1).toContain('wrap @args');
    expect(ps1).not.toContain('wrap -- @args');
  });

  it('the sh shim survives a PATH entry containing spaces', async () => {
    // `tr ':' ' '` tore `/c/Program Files/nodejs` into two directories that do
    // not exist, so the uninstall fallback silently found nothing.
    const { installShim } = await shell();
    installShim();
    const sh = fs.readFileSync(path.join(shimDirPath, 'claude'), 'utf8');
    expect(sh).toContain('IFS=:');
    expect(sh).not.toMatch(/tr ':' ' '/);
  });

  it('uninstall removes what install created', async () => {
    const { installShim, uninstallShim, shimInstalled } = await shell();
    installShim();
    expect(shimInstalled()).toBe(true);
    uninstallShim();
    expect(shimInstalled()).toBe(false);
  });
});

describe('shimOnPath / shimTakesPrecedence', () => {
  it('detects the directory regardless of case or a trailing slash', async () => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    const { shimOnPath } = await shell();
    expect(shimOnPath({ PATH: shimDirPath.toLowerCase() })).toBe(true);
    expect(shimOnPath({ PATH: shimDirPath + path.sep })).toBe(true);
  });

  it('handles a quoted PATH entry', async () => {
    const { shimOnPath } = await shell();
    expect(shimOnPath({ PATH: `"${shimDirPath}"` })).toBe(true);
  });

  it('reports NOT taking precedence when the real claude comes first', async () => {
    // Membership alone is not enough: a user who appends the directory gets a
    // shim that is never reached and a status screen that says it is fine.
    const { installShim, shimOnPath, shimTakesPrecedence } = await shell();
    installShim();
    writeRealClaude();
    const env = { PATH: `${realDir}${sep}${shimDirPath}` };
    expect(shimOnPath(env)).toBe(true);
    expect(shimTakesPrecedence(env)).toBe(false);
  });

  it('reports taking precedence when it comes first', async () => {
    const { installShim, shimTakesPrecedence } = await shell();
    installShim();
    writeRealClaude();
    expect(shimTakesPrecedence({ PATH: `${shimDirPath}${sep}${realDir}` })).toBe(true);
  });
});

describe('locateClaude', () => {
  it('never returns its own shim, even for a case-differing PATH entry', async () => {
    // On POSIX this mis-resolution is an unbounded fork bomb: shim -> ckm wrap
    // -> shim -> ...
    const { installShim } = await shell();
    const { locateClaude } = await locate();
    installShim();
    const real = writeRealClaude();

    for (const shimEntry of [shimDirPath, shimDirPath.toLowerCase(), shimDirPath + path.sep]) {
      const found = locateClaude({ PATH: `${shimEntry}${sep}${realDir}` });
      expect(found, shimEntry).toBe(real);
    }
  });

  it('honours CKM_CLAUDE_BIN above PATH', async () => {
    const { locateClaude } = await locate();
    const real = writeRealClaude();
    expect(locateClaude({ CKM_CLAUDE_BIN: real, PATH: '' })).toBe(real);
  });

  it('falls back to well-known install locations when PATH has nothing', async () => {
    // A daemon started by launchd or systemd runs with a minimal PATH, so PATH
    // alone is not enough to find Claude Code. Whatever comes back must still
    // be a real executable and must never be our own shim.
    const { installShim } = await shell();
    const { locateClaude } = await locate();
    installShim();

    const found = locateClaude({ PATH: path.join(home, 'empty') });
    if (found !== null) {
      expect(fs.statSync(found).isFile()).toBe(true);
      expect(path.dirname(path.resolve(found)).toLowerCase()).not.toBe(shimDirPath.toLowerCase());
    }
  });

  it('prefers a real .exe over the npm batch shim beside it', async () => {
    if (process.platform !== 'win32') return;
    const { locateClaude } = await locate();
    // Recreate npm's layout: claude.cmd at the top, claude.exe in node_modules.
    const npmDir = path.join(home, 'npmbin');
    const pkgBin = path.join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
    fs.mkdirSync(pkgBin, { recursive: true });
    fs.writeFileSync(path.join(npmDir, 'claude.cmd'), '@echo off\n');
    const exe = path.join(pkgBin, 'claude.exe');
    fs.writeFileSync(exe, 'MZ');

    // child_process refuses to spawn a .cmd, so returning the shim is fatal.
    expect(locateClaude({ PATH: npmDir })).toBe(exe);
  });
});

describe('supervision depth', () => {
  it('counts nesting instead of relying on a boolean', async () => {
    const { supervisionDepth, MAX_SUPERVISION_DEPTH, SUPERVISION_DEPTH_VAR } = await locate();
    expect(supervisionDepth({})).toBe(0);
    expect(supervisionDepth({ [SUPERVISION_DEPTH_VAR]: '1' })).toBe(1);
    expect(supervisionDepth({ [SUPERVISION_DEPTH_VAR]: 'nonsense' })).toBe(0);
    expect(MAX_SUPERVISION_DEPTH).toBeGreaterThan(0);
  });
});
