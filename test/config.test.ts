/**
 * A hand-edited config must not be able to turn the supervisor into a hazard.
 */

import { describe, expect, it } from 'vitest';
import { coerceConfigValue, DEFAULT_CONFIG, sanitiseConfig } from '../src/config/index.js';
import { isSafeContinuation } from '../src/pty/inject.js';

describe('sanitiseConfig', () => {
  it('returns defaults for an empty object', () => {
    expect(sanitiseConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it('has both jobs on by default', () => {
    // The tool should work after `ckm setup` without a second decision. Idle
    // claiming spends quota, so it is bounded by caps and announced loudly
    // rather than being off.
    expect(DEFAULT_CONFIG.autoContinue).toBe(true);
    expect(DEFAULT_CONFIG.idleClaim).toBe(true);
  });

  it('still bounds idle claiming from above', () => {
    expect(DEFAULT_CONFIG.maxIdleClaimsPerWeek).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.maxIdleClaimsPerWeek).toBeLessThanOrEqual(100);
  });

  it('clamps a negative boundary buffer to zero', () => {
    // Otherwise a boundary reads as "due" before the window has ended, and every
    // claim is a request that must fail.
    expect(sanitiseConfig({ boundaryBufferMs: -3_600_000 }).boundaryBufferMs).toBe(0);
  });

  it('raises a too-small poll interval to something survivable', () => {
    // setInterval(0) becomes 1ms, which hammers the shared state lock.
    expect(sanitiseConfig({ pollIntervalMs: 0 }).pollIntervalMs).toBeGreaterThanOrEqual(1_000);
    expect(sanitiseConfig({ pollIntervalMs: -5 }).pollIntervalMs).toBeGreaterThanOrEqual(1_000);
  });

  it('caps absurd values at the top end too', () => {
    expect(sanitiseConfig({ maxResumesPerSession: 10_000 }).maxResumesPerSession).toBeLessThanOrEqual(50);
    expect(sanitiseConfig({ maxIdleClaimsPerWeek: 1e9 }).maxIdleClaimsPerWeek).toBeLessThanOrEqual(100);
  });

  it('ignores values of the wrong type', () => {
    const dirty = { pollIntervalMs: 'soon', autoContinue: 'yes' } as unknown as Record<string, unknown>;
    const clean = sanitiseConfig(dirty);
    expect(clean.pollIntervalMs).toBe(DEFAULT_CONFIG.pollIntervalMs);
    expect(clean.autoContinue).toBe(DEFAULT_CONFIG.autoContinue);
  });

  it('rejects NaN and Infinity', () => {
    expect(sanitiseConfig({ pollIntervalMs: NaN }).pollIntervalMs).toBe(DEFAULT_CONFIG.pollIntervalMs);
    expect(sanitiseConfig({ boundaryBufferMs: Infinity }).boundaryBufferMs).toBeLessThanOrEqual(30 * 60_000);
  });

  it('refuses an empty continuation, which would submit a blank line', () => {
    expect(sanitiseConfig({ continuationText: '   ' }).continuationText).toBe(DEFAULT_CONFIG.continuationText);
    expect(sanitiseConfig({ pingText: '' }).pingText).toBe(DEFAULT_CONFIG.pingText);
  });
});

describe('the words we type into a terminal', () => {
  it('every one of them is safe to inject', () => {
    // These are the only strings this tool ever types into someone's session,
    // so both must survive the injection guard.
    for (const text of [DEFAULT_CONFIG.continuationText, DEFAULT_CONFIG.pingText]) {
      expect(isSafeContinuation(text), text).toBe(true);
    }
  });

  it('is plain ASCII, so a PTY cannot mangle it', () => {
    for (const text of [
      DEFAULT_CONFIG.continuationText,
      DEFAULT_CONFIG.pingText,
      DEFAULT_CONFIG.nudgeText,
    ]) {
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7e]+$/.test(text), text).toBe(true);
    }
  });

  it('the ping stays short, because it only ever starts a throwaway session', () => {
    expect(DEFAULT_CONFIG.pingText.length).toBeLessThanOrEqual(8);
  });

  it('keeps a legitimate custom continuation', () => {
    expect(sanitiseConfig({ continuationText: 'carry on' }).continuationText).toBe('carry on');
  });
});

describe('coerceConfigValue', () => {
  it('parses booleans generously', () => {
    for (const yes of ['true', 'on', '1', 'YES']) expect(coerceConfigValue('idleClaim', yes)).toBe(true);
    for (const no of ['false', 'off', '0', 'No']) expect(coerceConfigValue('idleClaim', no)).toBe(false);
  });

  it('rejects nonsense rather than silently defaulting', () => {
    expect(() => coerceConfigValue('idleClaim', 'maybe')).toThrow();
    expect(() => coerceConfigValue('pollIntervalMs', 'often')).toThrow();
  });

  it('refuses out-of-range numbers at the CLI, with an explanation', () => {
    expect(() => coerceConfigValue('pollIntervalMs', '0')).toThrow(/between/);
    expect(() => coerceConfigValue('boundaryBufferMs', '-1')).toThrow(/between/);
  });

  it('accepts in-range numbers', () => {
    expect(coerceConfigValue('pollIntervalMs', '30000')).toBe(30_000);
  });
});
