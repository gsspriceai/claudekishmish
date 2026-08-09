/**
 * `ckm wrap -- <args...>` — what the shim actually runs.
 *
 * Starts the real `claude` inside a PTY we own, then supervises it. To the user
 * this is indistinguishable from running `claude` directly: same TUI, same keys,
 * same exit code. The difference only shows up when a usage window runs out.
 */

import { locateClaude } from '../../claude/locate.js';
import { readSessionFiles } from '../../claude/sessions.js';
import { loadConfig } from '../../config/index.js';
import { logError, logInfo } from '../../logger/index.js';
import { injectContinuation } from '../../pty/inject.js';
import { spawnPty, type PtySession } from '../../pty/host.js';
import {
  deregisterSession,
  registerSession,
  stillEligible,
  tick,
} from '../../supervisor/index.js';

/** Wait for Claude Code to publish the session descriptor for our child. */
async function awaitSessionId(
  pid: number,
  timeoutMs = 20_000,
): Promise<{ sessionId: string; cwd: string; name: string; procStart: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = readSessionFiles().find((s) => s.pid === pid);
    if (match) {
      return {
        sessionId: match.sessionId,
        cwd: match.cwd,
        name: match.name ?? match.sessionId.slice(0, 8),
        procStart: match.procStart ?? null,
      };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

export async function runWrap(args: string[]): Promise<number> {
  const config = loadConfig();

  const bin = locateClaude();
  if (!bin) {
    process.stderr.write(
      'claudekishmish: could not find the real `claude` on PATH.\n' +
        'Set CKM_CLAUDE_BIN to its full path, or run `ckm doctor`.\n',
    );
    return 127;
  }

  // Never supervise a supervised session — that would nest PTYs.
  if (process.env.CKM_SUPERVISED === '1' || process.env.CKM_INTERNAL === '1') {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(bin, args, { stdio: 'inherit' });
    return r.status ?? 0;
  }

  const pty: PtySession = await spawnPty(bin, args, process.cwd());

  if (!pty.canInject) {
    process.stderr.write(
      'claudekishmish: node-pty is unavailable, so this session cannot be continued in place.\n' +
        'Supervision and boundary claiming still work. Run `ckm doctor` for details.\n',
    );
  }

  const descriptor = await awaitSessionId(pty.pid);
  let sessionId: string | null = null;

  if (descriptor) {
    sessionId = descriptor.sessionId;
    registerSession({
      sessionId: descriptor.sessionId,
      pid: pty.pid,
      procStart: descriptor.procStart,
      cwd: descriptor.cwd,
      name: descriptor.name,
      ptyOwned: pty.canInject,
      paused: false,
      pendingResume: false,
      resumeCount: 0,
      limit: null,
    });
  } else {
    logError('wrap.no_session_descriptor', { pid: pty.pid });
  }

  const resume = async (id: string): Promise<boolean> => {
    // State can change between scheduling a resume and performing it.
    if (!stillEligible(id, config)) {
      logInfo('resume.skipped', { sessionId: id, reason: 'no longer eligible' });
      return false;
    }
    const outcome = await injectContinuation(pty, config.continuationText);
    if (!outcome.ok) logError('resume.inject_failed', { reason: outcome.reason });
    return outcome.ok;
  };

  let stopped = false;
  const loop = setInterval(() => {
    if (stopped || !sessionId) return;
    void tick({ ownSessionId: sessionId, resume, config }).catch((err: Error) => {
      logError('tick.failed', { message: err.message });
    });
  }, config.pollIntervalMs);

  return await new Promise<number>((resolve) => {
    pty.onExit((code) => {
      stopped = true;
      clearInterval(loop);
      if (sessionId) deregisterSession(sessionId);
      resolve(code);
    });
  });
}
