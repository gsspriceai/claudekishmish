/**
 * Classify why a `claude` invocation failed.
 *
 * The distinction that matters is **transient vs terminal**. A network blip is
 * worth retrying in thirty seconds. A logged-out account or an ended
 * subscription is not: every future attempt fails identically, so retrying is
 * pure noise, and a background daemon would go on producing it forever —
 * several times a day, silently, for as long as the machine is on.
 *
 * On a terminal failure the tool halts itself and says so, and only a human
 * clears it.
 */

import type { HaltState } from '../state/schema.js';

export type FailureClass =
  | { kind: 'transient'; detail: string }
  | { kind: 'terminal'; reason: HaltState['reason']; detail: string };

/**
 * Signals that the account cannot make requests at all.
 *
 * `Not logged in · Please run /login` is the exact string Claude Code prints
 * when OAuth credentials are unavailable.
 */
const AUTH_PATTERNS: RegExp[] = [
  /not logged in/i,
  /please run \/login/i,
  /\bplease log ?in\b/i,
  /invalid api key/i,
  /authentication[_ ]error/i,
  /unauthori[sz]ed/i,
  /\b401\b/,
  /oauth token (has )?expired/i,
  /credentials (are )?(invalid|expired)/i,
];

/** Signals that the plan or balance, rather than the credentials, is the problem. */
const SUBSCRIPTION_PATTERNS: RegExp[] = [
  /subscription (has )?(ended|expired|lapsed|is inactive)/i,
  /no active subscription/i,
  /credit balance is too low/i,
  /insufficient (credits|balance|quota)/i,
  /payment (required|method)/i,
  /billing/i,
  /upgrade your plan/i,
  /\b402\b/,
  /\/usage-credits/i,
];

/**
 * Decide how to treat a failed invocation.
 *
 * Both streams are inspected: Claude Code prints `Not logged in` to **stdout**,
 * so a classifier that only read stderr would see an empty reason and treat the
 * one failure the user most needs explained as a retryable blip.
 */
export function classifyFailure(exitCode: number | null, stdout: string, stderr: string): FailureClass {
  const text = `${stdout}\n${stderr}`.trim();
  const detail = firstMeaningfulLine(text) || `exit ${exitCode ?? 'null'}`;

  for (const re of SUBSCRIPTION_PATTERNS) {
    if (re.test(text)) return { kind: 'terminal', reason: 'subscription', detail };
  }
  for (const re of AUTH_PATTERNS) {
    if (re.test(text)) return { kind: 'terminal', reason: 'auth', detail };
  }
  return { kind: 'transient', detail };
}

/** The first line that actually says something, for a one-line log entry. */
function firstMeaningfulLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 200);
  }
  return '';
}

/** Human-facing explanation of a halt, shown by `ckm status` and `ckm doctor`. */
export function haltAdvice(reason: HaltState['reason']): string {
  switch (reason) {
    case 'auth':
      return 'Claude Code is not logged in. Run `claude` and sign in, then `ckm resume --all`.';
    case 'subscription':
      return 'Your Claude subscription or credit balance will not allow requests. Once it is active again, run `ckm resume --all`.';
    default:
      return 'Requests are failing in a way retrying will not fix. Check `ckm logs`, then `ckm resume --all`.';
  }
}
