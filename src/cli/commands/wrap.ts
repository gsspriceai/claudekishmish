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
  hasExited: () => boolean,
): Promise<{ sessionId: string; cwd: string; name: string; procStart: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // `claude --version`, `--help`, `mcp list` and any scripted `-p` run print
    // and leave without ever publishing an interactive descriptor. Waiting the
    // full timeout for one would stall the user's shell on every such command.
    if (hasExited()) return null;
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

  // Registered before anything else can await: a short-lived invocation exits
  // in milliseconds, and an exit delivered to nobody is a hung terminal.
  let childExit: number | null = null;
  pty.onExit((code) => {
    childExit = code;
  });

  if (!pty.canInject) {
    process.stderr.write(
      'claudekishmish: node-pty is unavailable, so this session cannot be continued in place.\n' +
        'Supervision and boundary claiming still work. Run `ckm doctor` for details.\n',
    );
  }

  const descriptor = await awaitSessionDescriptor(pty.pid, 30_000, () => childExit !== null);
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

  let lastDeclineReason: string | null = null;
  const resume = async (id: string): Promise<boolean> => {
    // State can change between scheduling a resume and performing it.
    if (!stillEligible(id, loadConfig())) {
      logInfo('resume.skipped', { sessionId: id, reason: 'no longer eligible' });
      return false;
    }
    const outcome = await injectContinuation(pty, loadConfig().continuationText);
    if (!outcome.ok) {
      // A refusal is usually the guard doing its job — an unsent draft sitting
      // in the box. Logged once per distinct reason, at info: an all-night draft
      // was producing an error line every poll, thousands of them by morning.
      if (outcome.reason !== lastDeclineReason) {
        lastDeclineReason = outcome.reason;
        logInfo('resume.declined', { sessionId: id, reason: outcome.reason });
      }
    } else {
      lastDeclineReason = null;
    }
    return outcome.ok;
  };

  let ticking = false;
  let stopped = false;
  const loop = setInterval(() => {
    if (stopped || !sessionId || ticking) return;
    ticking = true;
    const id = sessionId;
    // Publish draft state so `ckm status` can show it; the guard that matters
    // is re-checked inside injectContinuation at the moment of writing.
    void reportDraftInput(id, pty.hasDraftInput())
      .catch((err: Error) => logWarn('draft.report_failed', { message: err.message }))
      // Re-read config every tick so `ckm config set` reaches a running wrapper.
      .then(() => tick({ actor: { id: ACTOR_ID, ownSessionId: id }, resume, config: loadConfig() }))
      .catch((err: Error) => logError('tick.failed', { message: err.message }))
      .finally(() => {
        ticking = false;
      });
  }, config.pollIntervalMs);
  loop.unref?.();

  // Already gone — a short command that finished during startup.
  if (childExit !== null) {
    clearInterval(loop);
    stopped = true;
    if (sessionId) await deregisterSession(sessionId);
    return childExit;
  }

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
