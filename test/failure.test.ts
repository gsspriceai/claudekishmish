/**
 * Classifying a failed `claude` invocation.
 *
 * The asymmetry that governs every case here: **failing to halt costs three
 * wasted pings; halting wrongly costs the user the entire tool** until they
 * notice a line in `ckm status`. So only unambiguous, Claude-specific phrasing
 * halts, and everything else is transient.
 */

import { describe, expect, it } from 'vitest';
import { classifyFailure, haltAdvice, haltExpiry, MODEL_CAP_BACKOFF_MS } from '../src/claude/failure.js';

describe('classifyFailure — what halts', () => {
  it('treats the real not-logged-in message as terminal', () => {
    // Verbatim from Claude Code 2.1.226 — printed to STDOUT, which is why both
    // streams are inspected.
    const result = classifyFailure(1, 'Not logged in · Please run /login', '');
    expect(result.kind).toBe('terminal');
    if (result.kind === 'terminal') expect(result.reason).toBe('auth');
  });

  it('finds it on stderr too', () => {
    expect(classifyFailure(1, '', 'Error: not logged in').kind).toBe('terminal');
  });

  it('treats an ended subscription as terminal', () => {
    for (const text of [
      'Your subscription has ended',
      'No active subscription for this account',
      'Your credit balance is too low to run this request',
      'Payment is required',
      'upgrade your plan to continue',
    ]) {
      const result = classifyFailure(1, text, '');
      expect(result.kind, text).toBe('terminal');
      if (result.kind === 'terminal') expect(result.reason, text).toBe('subscription');
    }
  });

  it('treats credential rejection as terminal', () => {
    for (const text of ['Invalid API key', 'authentication_error', 'OAuth token expired']) {
      expect(classifyFailure(1, text, '').kind, text).toBe('terminal');
    }
  });
});

/**
 * Every one of these produced a **permanent halt** on a perfectly working
 * account. `/\b401\b/` matched a corporate proxy's tunnelling error and a temp
 * file path; `/billing/i` matched any message quoting a console URL.
 */
describe('classifyFailure — what must NOT halt', () => {
  const falseAlarms: [string, string][] = [
    ['a corporate proxy blip', 'tunneling socket could not be established, statusCode=401'],
    ['a path that happens to contain 401', "ENOENT: no such file, open '/tmp/claude-401.json'"],
    ['a console URL in model output', 'see https://console.anthropic.com/settings/billing for details'],
    ['the word billing in prose', 'I updated the billing module as you asked'],
    ['a 402 mentioned in passing', 'the fixture returns 402 for that case'],
  ];

  it.each(falseAlarms)('does not halt on %s', (_label, text) => {
    expect(classifyFailure(1, text, '').kind).toBe('transient');
  });

  it('treats network and server trouble as transient', () => {
    for (const text of [
      'fetch failed',
      'ETIMEDOUT',
      'getaddrinfo ENOTFOUND api.anthropic.com',
      '500 Internal Server Error',
      'Overloaded',
      'socket hang up',
    ]) {
      expect(classifyFailure(1, text, '').kind, text).toBe('transient');
    }
  });

  it('defaults to transient when it cannot tell', () => {
    expect(classifyFailure(1, '', '').kind).toBe('transient');
    expect(classifyFailure(2, 'some unexpected output', '').kind).toBe('transient');
  });
});

/**
 * A per-model cap is neither of the other two: the account and the credentials
 * are fine, and it clears on its own. Classifying it as an ended subscription
 * made it a halt only a human could lift.
 */
describe('classifyFailure — a per-model cap is its own thing', () => {
  it('is not read as an ended subscription', () => {
    const result = classifyFailure(1, "You've reached your Fable 5 limit. Run /usage-credits to continue", '');
    expect(result.kind).toBe('terminal');
    if (result.kind === 'terminal') expect(result.reason).toBe('model');
  });

  it('also catches the switch-models wording', () => {
    const result = classifyFailure(1, 'switch models with /model', '');
    if (result.kind === 'terminal') expect(result.reason).toBe('model');
  });

  it('lifts by itself, unlike auth and subscription', () => {
    const now = 1_000_000;
    expect(haltExpiry('model', now)).toBe(now + MODEL_CAP_BACKOFF_MS);
    expect(haltExpiry('auth', now)).toBeNull();
    expect(haltExpiry('subscription', now)).toBeNull();
    expect(haltExpiry('unknown', now)).toBeNull();
  });
});

describe('detail lines', () => {
  it('reports a usable one-line reason, never an empty one', () => {
    const result = classifyFailure(1, '\n\n  Not logged in · Please run /login  \n', '');
    expect(result.detail).toBe('Not logged in · Please run /login');
  });

  it('falls back to the exit code when both streams are silent', () => {
    expect(classifyFailure(7, '', '').detail).toBe('exit 7');
  });
});

describe('haltAdvice', () => {
  it('tells the user what to do for every reason', () => {
    for (const reason of ['auth', 'subscription', 'model', 'unknown'] as const) {
      expect(haltAdvice(reason), reason).toMatch(/ckm resume --all/);
    }
    expect(haltAdvice('auth')).toMatch(/sign in/i);
    expect(haltAdvice('subscription')).toMatch(/subscription|credit/i);
    // The model one must say it clears itself, or the user will think they have
    // to act.
    expect(haltAdvice('model')).toMatch(/by itself|resumes/i);
  });
});
