/**
 * The cache that makes per-tick reconciliation affordable.
 *
 * It is also the cache that makes per-tick reconciliation *dangerous* if it is
 * wrong: a stale entry means a missed turn, a missed turn means a mis-phased
 * window, and a mis-phased window is the exact bug the reconciler exists to
 * fix. So the two properties tested hardest are "an unchanged file is not
 * re-read" and "a changed file always is" — the second matters more.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cachedUserTurnTimes, clearTurnCache, lastScanStats } from '../src/claude/turn-cache.js';
import { allUserTurnTimes } from '../src/claude/transcript.js';

let root: string;

beforeEach(() => {
  clearTurnCache();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-turns-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A transcript, in the shape Claude Code actually writes. */
function writeTranscript(project: string, id: string, timestamps: string[]): string {
  const dir = path.join(root, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = timestamps.map((t) =>
    JSON.stringify({ type: 'user', timestamp: t, message: { role: 'user', content: 'hi' } }),
  );
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

function append(file: string, timestamp: string): void {
  fs.appendFileSync(
    file,
    JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: 'more' } }) + '\n',
    'utf8',
  );
  // Filesystems store mtime coarsely, and a test that appends within the same
  // millisecond as the first write would be testing the clock, not the cache.
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(file, later, later);
}

describe('cachedUserTurnTimes', () => {
  it('returns exactly what a full scan returns', () => {
    // If these ever disagree, the cheap path is quietly deciding the window.
    writeTranscript('proj-a', 's1', ['2026-08-11T01:00:00.000Z', '2026-08-11T02:00:00.000Z']);
    writeTranscript('proj-b', 's2', ['2026-08-11T01:30:00.000Z']);

    expect(cachedUserTurnTimes(root)).toEqual(allUserTurnTimes(root));
  });

  it('returns timestamps in ascending order across projects', () => {
    writeTranscript('proj-a', 's1', ['2026-08-11T03:00:00.000Z']);
    writeTranscript('proj-b', 's2', ['2026-08-11T01:00:00.000Z']);

    const times = cachedUserTurnTimes(root);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('does not re-read a file that has not changed', () => {
    writeTranscript('proj-a', 's1', ['2026-08-11T01:00:00.000Z']);

    cachedUserTurnTimes(root);
    expect(lastScanStats()).toEqual({ read: 1, cached: 0 });

    cachedUserTurnTimes(root);
    expect(lastScanStats()).toEqual({ read: 0, cached: 1 });
  });

  it('re-reads a file that gained a turn, and returns the new turn', () => {
    // The failure that matters. A cache that misses an append leaves the
    // reconciler deriving the window from a history that stops early.
    const file = writeTranscript('proj-a', 's1', ['2026-08-11T01:00:00.000Z']);
    expect(cachedUserTurnTimes(root)).toHaveLength(1);

    append(file, '2026-08-11T09:00:00.000Z');

    const times = cachedUserTurnTimes(root);
    expect(lastScanStats().read).toBe(1);
    expect(times).toHaveLength(2);
    expect(times[1]).toBe(Date.parse('2026-08-11T09:00:00.000Z'));
  });

  it('picks up a brand-new transcript in an existing project', () => {
    writeTranscript('proj-a', 's1', ['2026-08-11T01:00:00.000Z']);
    cachedUserTurnTimes(root);

    writeTranscript('proj-a', 's2', ['2026-08-11T07:00:00.000Z']);
    expect(cachedUserTurnTimes(root)).toHaveLength(2);
  });

  it('picks up a brand-new project directory', () => {
    // A claim runs in the OS temp directory, so it creates its own project the
    // first time it ever fires. Missing that means never seeing our own claims.
    writeTranscript('proj-a', 's1', ['2026-08-11T01:00:00.000Z']);
    cachedUserTurnTimes(root);

    writeTranscript('proj-new', 's9', ['2026-08-11T07:00:00.000Z']);
    expect(cachedUserTurnTimes(root)).toHaveLength(2);
  });

  it('forgets a transcript that was deleted', () => {
    const file = writeTranscript('proj-a', 's1', ['2026-08-11T01:00:00.000Z']);
    writeTranscript('proj-a', 's2', ['2026-08-11T02:00:00.000Z']);
    cachedUserTurnTimes(root);

    fs.rmSync(file);
    const times = cachedUserTurnTimes(root);
    expect(times).toHaveLength(1);
    expect(times[0]).toBe(Date.parse('2026-08-11T02:00:00.000Z'));
  });

  it('survives an unreadable projects directory', () => {
    expect(cachedUserTurnTimes(path.join(root, 'does-not-exist'))).toEqual([]);
  });

  it('ignores files that are not transcripts', () => {
    writeTranscript('proj-a', 's1', ['2026-08-11T01:00:00.000Z']);
    fs.writeFileSync(path.join(root, 'proj-a', 'notes.txt'), 'not a transcript', 'utf8');

    expect(cachedUserTurnTimes(root)).toHaveLength(1);
    expect(lastScanStats().read).toBe(1);
  });
});
