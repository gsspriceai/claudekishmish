/**
 * Classifying a failed `claude` invocation.
 *
 * The distinction decides whether the tool retries or stops. Getting it wrong in
 * the "stop" direction loses a boundary; getting it wrong in the "retry"
 * direction means a background daemon repeats an impossible request several
 * times a day, for ever, for as long as the machine is on.
 */

import { describe, expect, it } from 'vitest';
import { classifyFailure, haltAdvice } from '../src/claude/failure.js';

describe('classifyFailure', () => {
  it('treats the real not-logged-in message as terminal', () => {
    // Verbatim from Claude Code 2.1.226 — and it is printed to STDOUT, which is
    // why both streams are inspected.
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
      'Payment required',
      'upgrade your plan to continue',
    ]) {
      const result = classifyFailure(1, text, '');
      expect(result.kind, text).toBe('terminal');
      if (result.kind === 'terminal') expect(result.reason, text).toBe('subscription');
    }
  });

  it('treats credential rejection as terminal', () => {
    for (const text of ['Invalid API key', 'authentication_error', '401 Unauthorized', 'OAuth token expired']) {
      expect(classifyFailure(1, text, '').kind, text).toBe('terminal');
    }
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
    // A boundary is worth retrying for; only a recognised terminal signal halts.
    expect(classifyFailure(1, '', '').kind).toBe('transient');
    expect(classifyFailure(2, 'some unexpected output', '').kind).toBe('transient');
  });

  it('reports a usable one-line reason, never an empty one', () => {
    const result = classifyFailure(1, '\n\n  Not logged in · Please run /login  \n', '');
    expect(result.detail).toBe('Not logged in · Please run /login');
  });

  it('falls back to the exit code when both streams are silent', () => {
    expect(classifyFailure(7, '', '').detail).toBe('exit 7');
  });

  it('prefers the subscription reading when both signals appear', () => {
    const result = classifyFailure(1, 'Please log in — your subscription has ended', '');
    if (result.kind === 'terminal') expect(result.reason).toBe('subscription');
  });
});

describe('haltAdvice', () => {
  it('tells the user what to do, including how to clear the halt', () => {
    for (const reason of ['auth', 'subscription', 'unknown'] as const) {
      expect(haltAdvice(reason)).toMatch(/ckm resume --all/);
    }
    expect(haltAdvice('auth')).toMatch(/sign in/i);
    expect(haltAdvice('subscription')).toMatch(/subscription|credit/i);
  });
});
