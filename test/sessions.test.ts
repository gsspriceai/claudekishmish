import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  liveTerminalSessions,
  readSessionFiles,
  sessionStillRunning,
  pidAlive,
} from '../src/claude/sessions.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-sessions-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The descriptor shape Claude Code actually writes, verbatim. */
function writeDescriptor(over: Record<string, unknown> = {}): void {
  const base = {
    pid: 23120,
    sessionId: '98399394-864e-4a9a-82bb-f81f42df5e16',
    cwd: 'E:\\ZLASH BACKEND',
    startedAt: 1786195352176,
    procStart: '134306689508165532',
    version: '2.1.226',
    peerProtocol: 1,
    kind: 'interactive',
    entrypoint: 'cli',
    name: 'zlash-backend-26',
    nameSource: 'derived',
    status: 'busy',
    updatedAt: 1786271386103,
  };
  const merged = { ...base, ...over };
  fs.writeFileSync(path.join(dir, `${merged.pid}.json`), JSON.stringify(merged), 'utf8');
}

const alive = () => true;
const dead = () => false;

describe('readSessionFiles', () => {
  it('reads well-formed descriptors', () => {
    writeDescriptor();
    expect(readSessionFiles(dir)).toHaveLength(1);
  });

  it('skips a half-written descriptor rather than throwing', () => {
    writeDescriptor();
    fs.writeFileSync(path.join(dir, '999.json'), '{"pid": 999, "sess', 'utf8');
    // Partial writes are normal during session startup.
    expect(readSessionFiles(dir)).toHaveLength(1);
  });

  it('ignores non-JSON files', () => {
    writeDescriptor();
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello', 'utf8');
    expect(readSessionFiles(dir)).toHaveLength(1);
  });

  it('returns empty when the directory does not exist', () => {
    expect(readSessionFiles(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('liveTerminalSessions', () => {
  it('accepts an interactive CLI session whose process is alive', () => {
    writeDescriptor();
    expect(liveTerminalSessions(dir, alive)).toHaveLength(1);
  });

  it('excludes a session whose process is gone', () => {
    writeDescriptor();
    expect(liveTerminalSessions(dir, dead)).toHaveLength(0);
  });

  it('excludes non-interactive sessions', () => {
    // Background agents and SDK sessions are not "open in a terminal", which is
    // the whole scope rule for auto-continue.
    writeDescriptor({ pid: 1, kind: 'background' });
    writeDescriptor({ pid: 2, entrypoint: 'sdk' });
    expect(liveTerminalSessions(dir, alive)).toHaveLength(0);
  });
});

describe('sessionStillRunning', () => {
  const id = '98399394-864e-4a9a-82bb-f81f42df5e16';

  it('is true for a matching live session', () => {
    writeDescriptor();
    expect(sessionStillRunning(id, '134306689508165532', dir, alive)).toBe(true);
  });

  it('is false when the descriptor is gone', () => {
    expect(sessionStillRunning(id, '134306689508165532', dir, alive)).toBe(false);
  });

  it('is false when the pid was reused by a different process', () => {
    // Same PID, different start stamp: a naive liveness check would wrongly
    // report this as our session and we could inject into a stranger's terminal.
    writeDescriptor({ procStart: '999999999999999999' });
    expect(sessionStillRunning(id, '134306689508165532', dir, alive)).toBe(false);
  });

  it('tolerates a descriptor with no procStart', () => {
    writeDescriptor({ procStart: undefined });
    expect(sessionStillRunning(id, null, dir, alive)).toBe(true);
  });
});

describe('pidAlive', () => {
  it('reports this process as alive', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it('reports an impossible pid as dead', () => {
    expect(pidAlive(2 ** 30)).toBe(false);
  });
});
