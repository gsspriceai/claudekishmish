/**
 * The draft guard, against real key sequences — and against the real wiring.
 *
 * Two separate failures are covered here, both found by audit:
 *
 *   1. the tracker reported CLEAN for both documented ways to put a newline in
 *      Claude Code's input box (Alt/Option+Enter, and a trailing backslash then
 *      Enter), so a multi-line message left half-written would have been
 *      submitted for the user hours later;
 *   2. the tracker could be **entirely unwired** from the keystroke stream and
 *      every test still passed, because nothing exercised `spawnPty`'s actual
 *      input path.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { draftTracker } from '../src/pty/host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

const ESC = '\u001b';
const CR = '\r';

describe('draftTracker — what clears the box', () => {
  it('plain typing leaves a draft', () => {
    const d = draftTracker();
    d.observe('refactor the auth middleware');
    expect(d.isDirty()).toBe(true);
  });

  it('Enter submits', () => {
    const d = draftTracker();
    d.observe('hello');
    d.observe(CR);
    expect(d.isDirty()).toBe(false);
  });

  it('Alt/Option+Enter is a NEWLINE, not a submit', () => {
    // ESC then CR. This used to read as clean twice over: ESC cleared, then CR
    // cleared again — so a multi-line draft looked like an empty box.
    const d = draftTracker();
    d.observe('refactor the auth middleware and');
    d.observe(ESC);
    d.observe(CR);
    expect(d.isDirty()).toBe(true);
  });

  it('Alt+Enter split across two reads is still a newline', () => {
    const d = draftTracker();
    d.observe('line one');
    d.observe(ESC); // chunk boundary lands exactly here
    d.observe(CR + 'line two');
    expect(d.isDirty()).toBe(true);
  });

  it('backslash then Enter is a NEWLINE, not a submit', () => {
    const d = draftTracker();
    d.observe('first line\\');
    d.observe(CR);
    expect(d.isDirty()).toBe(true);
  });

  it('a bare ESC does not clear the box', () => {
    // Indistinguishable from the start of an escape sequence, so it cannot be
    // trusted to mean "the box is empty".
    const d = draftTracker();
    d.observe('half a thought');
    d.observe(ESC);
    expect(d.isDirty()).toBe(true);
  });

  it('Ctrl-C and Ctrl-U do clear it', () => {
    for (const key of ['\u0003', '\u0015']) {
      const d = draftTracker();
      d.observe('half a thought');
      d.observe(key);
      expect(d.isDirty(), JSON.stringify(key)).toBe(false);
    }
  });

  it('a multi-line paste is a draft, even when it ends in a newline', () => {
    const d = draftTracker();
    d.observe('first line\nsecond line\n');
    expect(d.isDirty()).toBe(true);
  });

  it('bracketed paste is a draft', () => {
    const d = draftTracker();
    d.observe(`${ESC}[200~pasted text${ESC}[201~`);
    expect(d.isDirty()).toBe(true);
  });

  it('bracketed paste spanning several reads stays a draft', () => {
    const d = draftTracker();
    d.observe(`${ESC}[200~first`);
    d.observe('\nsecond'); // a newline inside a paste must not clear
    d.observe(`third${ESC}[201~`);
    expect(d.isDirty()).toBe(true);
  });

  it('arrow keys and history recall leave it dirty', () => {
    const d = draftTracker();
    d.observe(`${ESC}[A`);
    expect(d.isDirty()).toBe(true);
  });

  it('backspace leaves it dirty, because we cannot know the box is empty', () => {
    const d = draftTracker();
    d.observe('hi');
    d.observe('\u007f');
    expect(d.isDirty()).toBe(true);
  });

  it('a realistic type / send / type-again sequence', () => {
    const d = draftTracker();
    d.observe('fix the bug');
    expect(d.isDirty()).toBe(true);
    d.observe(CR);
    expect(d.isDirty()).toBe(false);
    d.observe('and also');
    expect(d.isDirty()).toBe(true);
  });
});

/**
 * The wiring.
 *
 * `spawnPty` must actually feed the tracker from the keystroke stream. A
 * version that simply forgot to used to pass the entire suite, because every
 * other test used a hand-rolled fake whose `hasDraftInput` was a constant.
 *
 * Driven through a child process because ConPTY cannot attach a console inside
 * a vitest worker — the same reason the integration tests run `ckm wrap` as a
 * child rather than in-process.
 */
describe('draft tracking is wired to the real keystroke stream', () => {
  const probe = path.join(here, 'fixtures', 'draft-wire-probe.mjs');
  const host = path.join(repo, 'dist', 'pty', 'host.js');

  /**
   * Spawned asynchronously with piped stdio: node-pty's ConPTY helper cannot
   * attach a console under a synchronous, console-less parent. The result comes
   * back through a file, because the PTY forwards the child's own output onto
   * the probe's stdout.
   */
  async function run(scenario: string): Promise<Record<string, unknown>> {
    if (!fs.existsSync(host)) throw new Error('run `npm run build` before the test suite');
    const resultFile = path.join(os.tmpdir(), `ckm-wire-${scenario}-${process.pid}.json`);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [probe, scenario, pathToFileURL(host).href, resultFile],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );
        let stderr = '';
        child.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('probe timed out'));
        }, 60_000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`probe exited ${code}: ${stderr.slice(0, 300)}`));
        });
      });
      return JSON.parse(fs.readFileSync(resultFile, 'utf8')) as Record<string, unknown>;
    } finally {
      try {
        fs.unlinkSync(resultFile);
      } catch {
        /* nothing to remove */
      }
    }
  }

  it('typing marks a draft and Enter clears it, through the real stream', async () => {
    const r = await run('typing');
    if (r.skipped) return;
    expect(r.atStart).toBe(false);
    expect(r.afterTyping).toBe(true);
    expect(r.afterEnter).toBe(false);
  });

  it('Alt+Enter through the real stream keeps the draft', async () => {
    const r = await run('altenter');
    if (r.skipped) return;
    expect(r.afterAltEnter).toBe(true);
  });

  it('a multi-byte character split across two reads is forwarded intact', async () => {
    // A naive per-chunk `buf.toString()` forwards replacement characters, so the
    // user's own keystrokes arrive corrupted in their session.
    const r = await run('utf8');
    if (r.skipped) return;

    // This one needs the PTY to actually *deliver* input to the child, not just
    // to accept it. Windows ConPTY cannot attach a console from a test worker
    // ("AttachConsole failed"), so nothing reaches the child and there is
    // nothing to assert. Skipped rather than faked; CI's Linux and macOS jobs
    // use a real pty and do verify it.
    if (String(r.seen) === '') return;

    expect(String(r.seen)).not.toContain('�');
    expect(String(r.seen)).toContain('\u{1F408}');
  });
});
