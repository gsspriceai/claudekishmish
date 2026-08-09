/**
 * The minimal boundary claim.
 *
 * This detail decides whether the whole feature is free or expensive. A claim
 * runs roughly five times a day; if it spawned an ordinary session it would load
 * CLAUDE.md, MCP servers, plugins and the full tool schema — tens of thousands of
 * tokens each time, all of it charged against the weekly budget the tool exists
 * to protect.
 *
 * `--bare` skips hooks, LSP, plugin sync, attribution, auto-memory, background
 * prefetches, keychain reads and CLAUDE.md discovery. With it, a claim costs a
 * few hundred tokens.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import { locateClaude } from '../claude/locate.js';
import { logAction, logError, logInfo } from '../logger/index.js';

export interface PingResult {
  ok: boolean;
  detail: string;
}

/** Arguments for the cheapest possible request that still anchors a window. */
export function pingArgs(text: string): string[] {
  return ['--bare', '--max-turns', '1', '--output-format', 'text', '-p', text];
}

/**
 * Send one minimal request to claim the boundary.
 *
 * Runs in the OS temp directory rather than any project, so nothing
 * project-shaped is discovered even if `--bare` ever stops covering something.
 */
export function sendPing(text: string, timeoutMs = 120_000): Promise<PingResult> {
  return new Promise((resolve) => {
    const bin = locateClaude();
    if (!bin) {
      resolve({ ok: false, detail: 'could not find the claude executable on PATH' });
      return;
    }

    const args = pingArgs(text);
    logAction('ping.start', { bin, args });

    const child = spawn(bin, args, {
      cwd: os.tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CKM_INTERNAL: '1' },
      windowsHide: true,
    });

    let stderr = '';
    let settled = false;
    const finish = (result: PingResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, detail: `ping timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on('data', () => {
      /* output is irrelevant; we only needed the request to land */
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      logError('ping.error', { message: err.message });
      finish({ ok: false, detail: err.message });
    });

    child.on('close', (code) => {
      if (code === 0) {
        logInfo('ping.ok', {});
        finish({ ok: true, detail: 'claimed' });
      } else {
        logError('ping.failed', { code, stderr: stderr.slice(0, 500) });
        finish({ ok: false, detail: `exit ${code}: ${stderr.slice(0, 200)}` });
      }
    });
  });
}

/**
 * Retry with exponential backoff.
 *
 * A boundary missed because the network was down at 03:00 shifts every later
 * boundary, so it is worth a few attempts before giving up.
 */
export async function sendPingWithRetry(
  text: string,
  attempts = 3,
  baseDelayMs = 30_000,
): Promise<PingResult> {
  let last: PingResult = { ok: false, detail: 'not attempted' };
  for (let i = 0; i < attempts; i++) {
    last = await sendPing(text);
    if (last.ok) return last;
    if (i < attempts - 1) {
      const delay = baseDelayMs * 2 ** i;
      logInfo('ping.retry', { attempt: i + 1, delayMs: delay });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return last;
}
