/**
 * `ckm wrap -- <args...>` — what the shim actually runs.
 *
 * Starts the real `claude` inside a PTY we own, then supervises it. To the user
 * this is indistinguishable from running `claude` directly: same TUI, same keys,
 * same exit code. The difference only shows up when a usage window runs out.
 */

import {
  locateClaude,
  MAX_SUPERVISION_DEPTH,
  supervisionDepth,
  SUPERVISION_DEPTH_VAR,
} from '../../claude/locate.js';
import { spawnClaudeSync } from '../../claude/spawn.js';
import { isInteractiveTerminalSession, readSessionFiles } from '../../claude/sessions.js';
import { loadConfig } from '../../config/index.js';
import { logError, logInfo, logWarn } from '../../logger/index.js';
import { injectContinuation } from '../../pty/inject.js';
import { spawnPty, type PtySession } from '../../pty/host.js';
import {
  ACTOR_ID,
  deregisterSession,
  registerSession,
  reportDraftInput,
  stillEligible,
  tick,
} from '../../supervisor/index.js';

/**
 * Wait for Claude Code to publish the session descriptor for our child.
 *
 * Only an interactive CLI session is accepted: that is the entire scope rule for
 * automatic continuation, and enforcing it here means a background or SDK
 * session is never registered in the first place.
 */
async function awaitSessionDescriptor(
  pid: number,
  timeoutMs: number,
): Promise<{ sessionId: string; cwd: string; name: string; procStart: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = (readSessionFiles() ?? []).find((s) => s.pid === pid);
    if (match) {
      if (!isInteractiveTerminalSession(match)) {
        logWarn('wrap.not_interactive', {
          kind: match.kind,
          entrypoint: match.entrypoint,
        });
        return null;
      }
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

  // If the shim ever resolves back to itself, fail loudly rather than forking.
  const depth = supervisionDepth();
  if (depth >= MAX_SUPERVISION_DEPTH) {
    process.stderr.write(
      'claudekishmish: the shim is resolving to itself — refusing to recurse.\n' +
        'Run `ckm doctor`; your PATH probably has the shim directory listed twice.\n',
    );
    return 1;
  }
  if (depth > 0 || process.env.CKM_INTERNAL === '1') {
    // Already supervised (or an internal call): run Claude straight through.
    const r = spawnClaudeSync(bin, args, { stdio: 'inherit' });
    return r.status ?? 0;
  }

  const pty: PtySession = await spawnPty(bin, args, process.cwd(), {
    [SUPERVISION_DEPTH_VAR]: String(depth + 1),
  });

  if (!pty.canInject) {
    process.stderr.write(
      'claudekishmish: node-pty is unavailable, so this session cannot be continued in place.\n' +
        'Supervision and boundary claiming still work. Run `ckm doctor` for details.\n',
    );
  }

  const descriptor = await awaitSessionDescriptor(pty.pid, 30_000);
  let sessionId: string | null = null;

  if (descriptor) {
    sessionId = descriptor.sessionId;
    await registerSession({
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
    logWarn('wrap.no_session_descriptor', { pid: pty.pid });
    process.stderr.write(
      'claudekishmish: this session was not registered, so it will not be auto-continued.\n' +
        '(Claude Code published no interactive session descriptor for it.)\n',
    );
  }

  const resume = async (id: string): Promise<boolean> => {
    // State can change between scheduling a resume and performing it.
    if (!stillEligible(id, loadConfig())) {
      logInfo('resume.skipped', { sessionId: id, reason: 'no longer eligible' });
      return false;
    }
    const outcome = await injectContinuation(pty, loadConfig().continuationText);
    if (!outcome.ok) logError('resume.inject_failed', { reason: outcome.reason });
    return outcome.ok;
  };

  /** Claim the boundary through this already-open session, rather than a new one. */
  const nudge = async (): Promise<boolean> => {
    if (pty.hasDraftInput()) {
      logInfo('nudge.skipped', { reason: 'user has an unsent draft' });
      return false;
    }
    const outcome = await injectContinuation(pty, loadConfig().pingText);
    if (!outcome.ok) logInfo('nudge.skipped', { reason: outcome.reason });
    return outcome.ok;
  };

  let ticking = false;
  let stopped = false;
  const loop = setInterval(() => {
    if (stopped || !sessionId || ticking) return;
    ticking = true;
    const id = sessionId;
    // Publish draft state before deciding: a nudge is chosen from shared state.
    void reportDraftInput(id, pty.hasDraftInput())
      .catch(() => undefined)
      // Re-read config every tick so `ckm config set` reaches a running wrapper.
      .then(() => tick({ actor: { id: ACTOR_ID, ownSessionId: id }, resume, nudge, config: loadConfig() }))
      .catch((err: Error) => logError('tick.failed', { message: err.message }))
      .finally(() => {
        ticking = false;
      });
  }, config.pollIntervalMs);
  loop.unref?.();

  return await new Promise<number>((resolve) => {
    pty.onExit((code) => {
      stopped = true;
      clearInterval(loop);
      void (async () => {
        if (sessionId) await deregisterSession(sessionId);
        resolve(code);
      })();
    });
  });
}
