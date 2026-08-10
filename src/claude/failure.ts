/**
 * Classify why a `claude` invocation failed.
 *
 * The distinction that matters is **transient vs terminal**. A network blip is
 * worth retrying in fifteen seconds. A logged-out account or an ended
 * subscription is not: every future attempt fails identically, so retrying is
 * pure noise, and a background daemon would go on producing it for as long as
 * the machine is on.
 *
 * ## Why the patterns are narrow
 *
 * A halt stops both features and, for auth and subscription, only a human
 * clears it. That asymmetry decides how to read an ambiguous string: **failing
 * to halt costs three wasted pings; halting wrongly costs the user the entire
 * tool until they notice a line in `ckm status`.** So only unambiguous,
 * Claude-specific phrasing halts, and everything else is transient.
 *
 * Loose patterns were doing real damage. `/\b401\b/` matched a corporate
 * proxy's `tunneling socket could not be established, statusCode=401` and a
 * temp-file path containing `401`; `/billing/i` matched any message quoting a
 * console URL. All four were permanent halts on a working account.
 */

import type { HaltState } from '../state/schema.js';

export type FailureClass =
  | { kind: 'transient'; detail: string }
  | { kind: 'terminal'; reason: HaltState['reason']; detail: string };

/**
 * The account cannot make requests at all.
 *
 * `Not logged in · Please run /login` is the exact string Claude Code prints
 * when OAuth credentials are unavailable.
 */
const AUTH_PATTERNS: RegExp[] = [
  /not logged in/i,
  /please run \/login/i,
  /\bplease log ?in\b/i,
  /invalid api key/i,
  /authentication_error/i,
  /oauth token (has )?expired/i,
  /credentials (are )?(invalid|expired)/i,
];

/** The plan or balance, rather than the credentials, blocks every request. */
const SUBSCRIPTION_PATTERNS: RegExp[] = [
  /subscription (has )?(ended|expired|lapsed|is inactive)/i,
  /no active subscription/i,
  /credit balance is too low/i,
  /insufficient (credits|balance|quota)/i,
  /payment (is )?required/i,
  /upgrade your plan/i,
];

/**
 * A per-model cap.
 *
 * Distinct from both: the account is fine and the credentials are fine, but the
 * model this request would use is capped. It clears on its own, so it must not
 * become a halt a human has to clear.
 */
const MODEL_CAP_PATTERNS: RegExp[] = [/\/usage-credits/i, /switch models with \/model/i];

/** A per-model cap suspends claiming for this long, then lifts by itself. */
export const MODEL_CAP_BACKOFF_MS = 6 * 3600_000;

/**
 * Decide how to treat a failed invocation.
 *
 * Both streams are inspected: Claude Code prints `Not logged in` to **stdout**,
 * so a classifier reading only stderr would see an empty reason and treat the
 * one failure the user most needs explained as a retryable blip.
 */
export function classifyFailure(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): FailureClass {
  const text = `${stdout}\n${stderr}`.trim();
  const detail = firstMeaningfulLine(text) || `exit ${exitCode ?? 'null'}`;

  // Checked before subscription: a model cap names a model and points at
  // /usage-credits, and must not be mistaken for an ended plan.
  for (const re of MODEL_CAP_PATTERNS) {
    if (re.test(text)) return { kind: 'terminal', reason: 'model', detail };
  }
  for (const re of SUBSCRIPTION_PATTERNS) {
    if (re.test(text)) return { kind: 'terminal', reason: 'subscription', detail };
  }
  for (const re of AUTH_PATTERNS) {
    if (re.test(text)) return { kind: 'terminal', reason: 'auth', detail };
  }
  return { kind: 'transient', detail };
}

/** Does a halt for this reason clear itself, and when? */
export function haltExpiry(reason: HaltState['reason'], now: number): number | null {
  return reason === 'model' ? now + MODEL_CAP_BACKOFF_MS : null;
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
    case 'model':
      return 'A per-model cap was hit. Claiming pauses by itself and resumes once the cap clears; `ckm resume --all` lifts it sooner.';
    default:
      return 'Requests are failing in a way retrying will not fix. Check `ckm logs`, then `ckm resume --all`.';
  }
}
