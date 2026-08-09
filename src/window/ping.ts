/**
 * The minimal boundary claim.
 *
 * ## Why not `--bare`
 *
 * `--bare` is the obvious way to make this request cheap — it skips hooks, LSP,
 * plugin sync, auto-memory and CLAUDE.md discovery. It also says, in the same
 * sentence: *"Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via
 * --settings (OAuth and keychain are never read)"*. For a subscription user —
 * which is nearly everyone — a `--bare` request therefore fails with
 * `Not logged in`, and the entire boundary-claiming feature never works.
 *
 * So the context is trimmed with flags that do not touch authentication:
 * no MCP servers, no skills, no session file, a one-word system prompt, and a
 * working directory with no project in it.
 *
 * ## What it actually costs
 *
 * Measured against a real subscription account:
 *
 *     input 2 · cache_read 21,963 · output 13 · ~5.6s   (~$0.023 at API rates)
 *
 * Not "a few hundred tokens" — the built-in tool schema dominates, and it is
 * read from the prompt cache. Restricting the tool set was measured too and is
 * *worse*: it changes the prompt, so the cache is missed entirely and the same
 * request costs an order of magnitude more. Riding the cache the user's normal
 * sessions already populate is the cheap path, so the tool set is left alone.
 */

import os from 'node:os';
import { locateClaude } from '../claude/locate.js';
import { spawnClaude } from '../claude/spawn.js';
import { classifyFailure, type FailureClass } from '../claude/failure.js';
import { logAction, logError, logInfo, logWarn } from '../logger/index.js';

export interface PingResult {
  ok: boolean;
  detail: string;
  /** Present when the request failed; decides whether retrying is worthwhile. */
  failure?: FailureClass;
}

/**
 * The cheapest request that still anchors a window without breaking auth.
 *
 * `--strict-mcp-config` with no `--mcp-config` loads zero MCP servers.
 * `--no-session-persistence` keeps the claim out of the transcript history.
 * `--system-prompt` replaces the full default prompt with a single character.
 */
export function pingArgs(text: string): string[] {
  return [
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt',
    '.',
    '--max-turns',
    '1',
    '--output-format',
    'text',
    '-p',
    text,
  ];
}

/**
 * Send one minimal request to claim the boundary.
 *
 * Runs in the OS temp directory rather than any project, so no CLAUDE.md and no
 * project settings are discovered.
 */
export function sendPing(text: string, timeoutMs = 120_000): Promise<PingResult> {
  return new Promise((resolve) => {
    const bin = locateClaude();
    if (!bin) {
      resolve({
        ok: false,
        detail: 'could not find the claude executable on PATH',
        failure: { kind: 'terminal', reason: 'unknown', detail: 'claude not found on PATH' },
      });
      return;
    }

    const args = pingArgs(text);
    logAction('ping.start', { bin, args });

    let child;
    try {
      child = spawnClaude(bin, args, {
        cwd: os.tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CKM_INTERNAL: '1' },
        windowsHide: true,
      });
    } catch (err) {
      // spawn can throw synchronously (notably EINVAL on a Windows batch shim),
      // in which case the 'error' event never fires.
      const message = (err as Error).message;
      logError('ping.spawn_threw', { message });
      resolve({ ok: false, detail: message, failure: { kind: 'transient', detail: message } });
      return;
    }

    let stdout = '';
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
      const detail = `ping timed out after ${timeoutMs}ms`;
      finish({ ok: false, detail, failure: { kind: 'transient', detail } });
    }, timeoutMs);

    // Both streams are captured: Claude Code prints "Not logged in" to stdout,
    // and that is precisely the message worth acting on.
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      logError('ping.error', { message: err.message });
      finish({ ok: false, detail: err.message, failure: { kind: 'transient', detail: err.message } });
    });

    child.on('close', (code) => {
      if (code === 0) {
        logInfo('ping.ok', {});
        finish({ ok: true, detail: 'claimed' });
        return;
      }
      const failure = classifyFailure(code, stdout, stderr);
      logError('ping.failed', { code, kind: failure.kind, detail: failure.detail });
      finish({ ok: false, detail: failure.detail, failure });
    });
  });
}

/**
 * Retry with exponential backoff — but only what retrying can fix.
 *
 * A missed boundary shifts every later boundary, so a transient failure is
 * worth a few attempts. A terminal one (logged out, subscription ended) returns
 * immediately: the caller halts the tool rather than repeating a request that
 * cannot succeed.
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

    if (last.failure?.kind === 'terminal') {
      logWarn('ping.terminal_failure', { detail: last.failure.detail, reason: last.failure.reason });
      return last;
    }
    if (i < attempts - 1) {
      const delay = baseDelayMs * 2 ** i;
      logInfo('ping.retry', { attempt: i + 1, delayMs: delay });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return last;
}
