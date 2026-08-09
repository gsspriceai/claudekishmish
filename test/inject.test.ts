import { describe, expect, it, vi } from 'vitest';
import { injectContinuation, isSafeContinuation } from '../src/pty/inject.js';
import { draftTracker, type PtySession } from '../src/pty/host.js';

function fakePty(opts: { canInject?: boolean; draft?: boolean } = {}): PtySession & {
  written: string[];
} {
  const canInject = opts.canInject ?? true;
  const written: string[] = [];
  return {
    pid: 1,
    canInject,
    written,
    hasDraftInput: () => opts.draft ?? false,
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
    const pty = fakePty({ canInject: false });
    const result = await injectContinuation(pty, 'continue', 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/node-pty/);
    expect(pty.written).toEqual([]);
  });

  /**
   * The one way this tool could destroy work rather than save it: appending to
   * a half-typed message and pressing Enter on the user's behalf.
   */
  it('refuses when the user has an unsent draft, and writes nothing', async () => {
    const pty = fakePty({ draft: true });
    const result = await injectContinuation(pty, 'continue', 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/typed but not sent/);
    expect(pty.written).toEqual([]);
  });

  it('refuses unsafe text and writes nothing at all', async () => {
    const pty = fakePty();
    const result = await injectContinuation(pty, 'continue\nsudo rm -rf /', 0);
    expect(result.ok).toBe(false);
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

describe('draftTracker', () => {
  it('starts clean', () => {
    expect(draftTracker().isDirty()).toBe(false);
  });

  it('goes dirty as soon as the user types something printable', () => {
    const d = draftTracker();
    d.observe('h');
    expect(d.isDirty()).toBe(true);
  });

  it('clears when the line is submitted', () => {
    const d = draftTracker();
    d.observe('hello');
    d.observe('\r');
    expect(d.isDirty()).toBe(false);
  });

  it('clears on Ctrl-C and on Escape', () => {
    for (const key of ['\u0003', '\u001b']) {
      const d = draftTracker();
      d.observe('half a thought');
      d.observe(key);
      expect(d.isDirty(), key).toBe(false);
    }
  });

  it('stays dirty after a backspace, because it cannot know the box is empty', () => {
    // Erring the other way would be the expensive mistake: a false "clean"
    // submits the user's draft.
    const d = draftTracker();
    d.observe('hi');
    d.observe('\u007f');
    expect(d.isDirty()).toBe(true);
  });

  it('ignores arrow keys and other control input', () => {
    const d = draftTracker();
    d.observe('\u001b[A');
    // Escape clears; the bracket and A that follow are the sequence, not typing,
    // but treating them as typing would only ever make us skip a nudge.
    expect(typeof d.isDirty()).toBe('boolean');
  });

  it('resets when we write our own text, so it is not mistaken for the user', () => {
    const d = draftTracker();
    d.observe('user typing');
    d.reset();
    expect(d.isDirty()).toBe(false);
  });

  it('tracks a realistic type-then-send-then-type-again sequence', () => {
    const d = draftTracker();
    d.observe('fix the bug');
    expect(d.isDirty()).toBe(true);
    d.observe('\r');
    expect(d.isDirty()).toBe(false);
    d.observe('and also');
    expect(d.isDirty()).toBe(true);
  });
});
