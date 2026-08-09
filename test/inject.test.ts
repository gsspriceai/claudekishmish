import { describe, expect, it, vi } from 'vitest';
import { injectContinuation, isSafeContinuation } from '../src/pty/inject.js';
import type { PtySession } from '../src/pty/host.js';

function fakePty(canInject = true): PtySession & { written: string[] } {
  const written: string[] = [];
  return {
    pid: 1,
    canInject,
    written,
    write(data: string) {
      written.push(data);
      return canInject;
    },
    onData() {},
    onExit() {},
    resize() {},
    kill() {},
  };
}

describe('isSafeContinuation', () => {
  it('accepts ordinary text', () => {
    expect(isSafeContinuation('continue')).toBe(true);
    expect(isSafeContinuation('carry on with the migration')).toBe(true);
  });

  it('rejects empty and over-long text', () => {
    expect(isSafeContinuation('')).toBe(false);
    expect(isSafeContinuation('x'.repeat(501))).toBe(false);
  });

  it('rejects newlines, which would submit more than one line', () => {
    expect(isSafeContinuation('continue\nrm -rf /')).toBe(false);
    expect(isSafeContinuation('continue\r')).toBe(false);
  });

  it('rejects escape sequences that would drive the TUI', () => {
    expect(isSafeContinuation('\u001b[A')).toBe(false);
    expect(isSafeContinuation('a\u0000b')).toBe(false);
    expect(isSafeContinuation('a\u0007')).toBe(false);
  });
});

describe('injectContinuation', () => {
  it('writes the text and then Enter', async () => {
    const pty = fakePty();
    const result = await injectContinuation(pty, 'continue', 0);
    expect(result.ok).toBe(true);
    expect(pty.written).toEqual(['continue', '\r']);
  });

  it('refuses when the host cannot inject', async () => {
    const pty = fakePty(false);
    const result = await injectContinuation(pty, 'continue', 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/node-pty/);
    expect(pty.written).toEqual([]);
  });

  it('refuses unsafe text and writes nothing at all', async () => {
    const pty = fakePty();
    const result = await injectContinuation(pty, 'continue\nsudo rm -rf /', 0);
    expect(result.ok).toBe(false);
    // Nothing must reach the terminal when the text is rejected.
    expect(pty.written).toEqual([]);
  });

  it('waits for the input box to settle before pressing Enter', async () => {
    const pty = fakePty();
    const spy = vi.spyOn(global, 'setTimeout');
    await injectContinuation(pty, 'continue', 250);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
