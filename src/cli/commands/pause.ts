/**
 * `ckm pause` / `ckm resume` — the kill switch.
 *
 * This has to be trustworthy above all else. The user asked for a way to stop
 * the automation before going to sleep, so both the wrapper and the daemon
 * re-read this flag on every tick and again immediately before acting.
 */

import { mutateState, readState } from '../../state/store.js';
import { logAction } from '../../logger/index.js';
import { liveTerminalSessions } from '../../claude/sessions.js';

/** Pick the session to act on: an explicit id, or the one in this directory. */
function resolveSessionId(explicit?: string): string | null {
  if (explicit) return explicit;
  const state = readState();
  const cwd = process.cwd();

  const here = Object.values(state.sessions).filter((s) => s.cwd === cwd);
  if (here.length === 1) return here[0]!.sessionId;
  if (here.length > 1) {
    // Most recently registered wins; it is the one the user is looking at.
    return here.sort((a, b) => b.registeredAt - a.registeredAt)[0]!.sessionId;
  }

  const live = liveTerminalSessions().filter((s) => s.cwd === cwd);
  return live[0]?.sessionId ?? null;
}

export function runPause(opts: { all?: boolean; session?: string }): number {
  if (opts.all) {
    mutateState((s) => ({ ...s, globalPaused: true }));
    logAction('pause.all', {});
    process.stdout.write('Paused everything. Nothing will be continued or claimed.\n');
    process.stdout.write('Re-enable with `ckm resume --all`.\n');
    return 0;
  }

  const id = resolveSessionId(opts.session);
  if (!id) {
    process.stderr.write(
      'No supervised session found for this directory.\n' +
        'Pass --session <id>, or use --all to pause everything.\n',
    );
    return 1;
  }

  const found = mutateSession(id, true);
  if (!found) {
    process.stderr.write(`Session ${id} is not being supervised.\n`);
    return 1;
  }
  logAction('pause.session', { sessionId: id });
  process.stdout.write(`Paused ${id.slice(0, 8)}. It will not be auto-continued.\n`);
  return 0;
}

export function runResume(opts: { all?: boolean; session?: string }): number {
  if (opts.all) {
    mutateState((s) => ({ ...s, globalPaused: false }));
    logAction('resume.all', {});
    process.stdout.write('Resumed. Automation is active again.\n');
    return 0;
  }

  const id = resolveSessionId(opts.session);
  if (!id) {
    process.stderr.write('No supervised session found for this directory.\n');
    return 1;
  }
  const found = mutateSession(id, false);
  if (!found) {
    process.stderr.write(`Session ${id} is not being supervised.\n`);
    return 1;
  }
  logAction('resume.session', { sessionId: id });
  process.stdout.write(`Resumed ${id.slice(0, 8)}.\n`);
  return 0;
}

function mutateSession(sessionId: string, paused: boolean): boolean {
  let found = false;
  mutateState((state) => {
    const session = state.sessions[sessionId];
    if (!session) return state;
    found = true;
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: { ...session, paused, updatedAt: Date.now() },
      },
    };
  });
  return found;
}
