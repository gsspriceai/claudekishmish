/**
 * Type a continuation into a session we own.
 *
 * Two safety properties matter here and both are structural rather than
 * advisory:
 *
 *   1. The text is always the configured `continuationText`. Nothing read from a
 *      transcript, a model response, or a terminal ever reaches this function,
 *      so there is no path from content the model produced to keystrokes in the
 *      user's terminal.
 *   2. The caller re-checks eligibility immediately before calling. State can
 *      change between scheduling a resume at 23:40 and performing it at 04:30 —
 *      the user may have paused it, or the session may be gone.
 */

import type { PtySession } from './host.js';
import { logAction, logWarn } from '../logger/index.js';

/** Carriage return is what a TUI reads as Enter. */
const ENTER = '\r';

/**
 * Control characters, escape sequences and newlines would drive the TUI rather
 * than talk to it, so a continuation must be one plain line of printable text.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Reject anything that is not a single plain line of text. */
export function isSafeContinuation(text: string): boolean {
  if (text.length === 0 || text.length > 500) return false;
  return !CONTROL_CHARS.test(text);
}

export interface InjectOutcome {
  ok: boolean;
  reason: string;
}

/**
 * Write the continuation followed by Enter.
 *
 * A short pause between the text and the Enter lets the TUI's input box settle;
 * without it a fast write can land before the prompt is ready to receive it.
 */
export async function injectContinuation(
  session: PtySession,
  text: string,
  settleMs = 250,
): Promise<InjectOutcome> {
  if (!session.canInject) {
    logWarn('inject.unsupported', { reason: 'node-pty unavailable' });
    return { ok: false, reason: 'in-place continuation needs node-pty' };
  }
  // Re-checked here, at the last possible moment: the decision was made from
  // state that may be seconds old, and the user may have started typing since.
  // Appending to their draft and pressing Enter would submit a half-written
  // message — the one way this tool could destroy work rather than save it.
  if (session.hasDraftInput()) {
    logWarn('inject.skipped_draft', { pid: session.pid });
    return { ok: false, reason: 'the user has something typed but not sent' };
  }
  if (!isSafeContinuation(text)) {
    logWarn('inject.rejected', { reason: 'unsafe continuation text' });
    return { ok: false, reason: 'continuation text rejected as unsafe' };
  }

  logAction('inject.write', { pid: session.pid, chars: text.length });

  if (!session.write(text)) {
    return { ok: false, reason: 'pty write failed' };
  }
  await new Promise((r) => setTimeout(r, settleMs));
  if (!session.write(ENTER)) {
    return { ok: false, reason: 'pty write failed on enter' };
  }

  return { ok: true, reason: 'continuation sent' };
}
