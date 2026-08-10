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
import { classifyLimitText } from '../claude/limits.js';
import { parseAnyReset } from '../claude/resetparse.js';
import type { LimitEvent } from '../state/schema.js';
import { logAction, logError, logInfo, logWarn } from '../logger/index.js';

export interface PingResult {
  ok: boolean;
  detail: string;
  /** Present when the request failed; decides whether retrying is worthwhile. */
  failure?: FailureClass;
  /**
   * A usage limit reported by the claim itself.
   *
   * The daemon reads limits from *supervised sessions'* transcripts, and
   * overnight there are none — so a limit that the claim runs into was
   * previously invisible. It retried three times every boundary until the cap
   * cleared, which for a weekly cap is thousands of refused requests.
   */
  limit?: LimitEvent;
}

/**
 * The cheapest request that still starts a real session, without breaking auth.
 *
 * `--strict-mcp-config` with no `--mcp-config` loads zero MCP servers.
 * `--system-prompt` replaces the full default prompt with a single character.
 *
 * ## Why the claim must be a persisted session
 *
 * `--no-session-persistence` was here at first, to keep these one-word claims
 * out of the transcript history. That was wrong, and it broke the feature in
 * precisely the case it exists for.
 *
 * A claim has to leave a record, because the window it opens is only visible to
 * us through transcripts: `deriveLedgerFromTurns` reads user turns to work out
 * where the current window starts. Overnight — the whole point of the daemon —
 * there is no other session running, so a claim that persisted nothing would
 * open a window that nothing on the machine could see. A restarted daemon would
 * then bootstrap from stale history and be out of phase with reality.
 *
 * Verified: without the flag, one claim creates one session transcript
 * containing one timestamped `user` turn (1074 -> 1075 transcripts), which is
 * exactly what the ledger needs.
 */
export function pingArgs(text: string): string[] {
  return [
    '--strict-mcp-config',
    '--disable-slash-commands',
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
 * Read a usage limit out of what the invocation printed, if there is one.
 *
 * The wording is the same as in a transcript; only the delivery differs.
 */
export function limitFromOutput(stdout: string, stderr: string, now: Date): LimitEvent | null {
  const text = [stdout, stderr].join('\n').trim();
  const kind = classifyLimitText(text);
  if (kind === null) return null;
  const resetAt = kind === 'model' ? null : (parseAnyReset(text, now)?.getTime() ?? null);
  return { kind, detectedAt: now.getTime(), resetAt, raw: firstLine(text) };
}

function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 200);
  }
  return text.slice(0, 200);
}

/**
 * Send one minimal request to claim the boundary.
 *
 * Runs in the OS temp directory rather than any project, so no CLAUDE.md and no
 * project settings are discovered.
 */
export function sendPing(text: string, timeoutMs = 60_000): Promise<PingResult> {
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
      const limit = limitFromOutput(stdout, stderr, new Date()) ?? undefined;
      logError('ping.failed', {
        code,
        kind: failure.kind,
        detail: failure.detail,
        limit: limit?.kind,
      });
      finish({ ok: false, detail: failure.detail, failure, limit });
    });
  });
}

/**
 * Retry with exponential backoff — but only what retrying can fix.
 *
 * A missed boundary shifts every later boundary, so a transient failure is
 * worth a few attempts. The budget is deliberately bounded — 3 attempts of 60s
 * with 15s and 30s backoff, so 225s worst case — because the whole act phase
 * has to finish inside the boundary reservation it holds. A measured claim
 * takes about 6 seconds. A terminal one (logged out, subscription ended) returns
 * immediately: the caller halts the tool rather than repeating a request that
 * cannot succeed.
 */
export async function sendPingWithRetry(
  text: string,
  attempts = 3,
  baseDelayMs = 15_000,
): Promise<PingResult> {
  let last: PingResult = { ok: false, detail: 'not attempted' };
  for (let i = 0; i < attempts; i++) {
    last = await sendPing(text);
    if (last.ok) return last;

    if (last.failure?.kind === 'terminal') {
      logWarn('ping.terminal_failure', { detail: last.failure.detail, reason: last.failure.reason });
      return last;
    }
    if (last.limit) {
      // The window is not open after all. Retrying cannot change that, and the
      // caller will fold the stated reset into the ledger.
      logWarn('ping.hit_limit', { kind: last.limit.kind });
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
