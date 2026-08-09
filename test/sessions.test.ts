import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkSessionLiveness,
  isInteractiveTerminalSession,
  liveTerminalSessions,
  pidAlive,
  readSessionFiles,
  sessionStillRunning,
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
  const merged = {
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
    ...over,
  };
  fs.writeFileSync(path.join(dir, `${merged.pid}.json`), JSON.stringify(merged), 'utf8');
}

const alive = () => true;
const dead = () => false;
const ID = '98399394-864e-4a9a-82bb-f81f42df5e16';

describe('readSessionFiles', () => {
  it('reads well-formed descriptors', () => {
    writeDescriptor();
    expect(readSessionFiles(dir)).toHaveLength(1);
  });

  it('skips a half-written descriptor rather than throwing', () => {
    writeDescriptor();
    fs.writeFileSync(path.join(dir, '999.json'), '{"pid": 999, "sess', 'utf8');
    expect(readSessionFiles(dir)).toHaveLength(1);
  });

  it('returns null — not an empty list — when the directory cannot be read', () => {
    // The difference matters: "[] sessions" would prune every supervised
    // session at once on a transient filesystem hiccup.
    expect(readSessionFiles(path.join(dir, 'nope'))).toBeNull();
  });
});

describe('isInteractiveTerminalSession', () => {
  it('accepts only an interactive CLI session', () => {
    expect(isInteractiveTerminalSession({ pid: 1, sessionId: 'x', cwd: '/', kind: 'interactive', entrypoint: 'cli' })).toBe(true);
    expect(isInteractiveTerminalSession({ pid: 1, sessionId: 'x', cwd: '/', kind: 'background', entrypoint: 'cli' })).toBe(false);
    expect(isInteractiveTerminalSession({ pid: 1, sessionId: 'x', cwd: '/', kind: 'interactive', entrypoint: 'sdk' })).toBe(false);
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

  it('excludes background and SDK sessions', () => {
    writeDescriptor({ pid: 1, kind: 'background' });
    writeDescriptor({ pid: 2, entrypoint: 'sdk' });
    expect(liveTerminalSessions(dir, alive)).toHaveLength(0);
  });
});

describe('checkSessionLiveness', () => {
  it('is alive for a matching interactive session', () => {
    writeDescriptor();
    expect(checkSessionLiveness(ID, '134306689508165532', 23120, dir, alive)).toBe('alive');
  });

  it('is gone when the pid was reused by a different process', () => {
    // A naive liveness check would say "alive" here and we could inject into a
    // stranger's terminal.
    writeDescriptor({ procStart: '999999999999999999' });
    expect(checkSessionLiveness(ID, '134306689508165532', 23120, dir, alive)).toBe('gone');
  });

  it('is gone if the session stopped being interactive', () => {
    writeDescriptor({ kind: 'background' });
    expect(checkSessionLiveness(ID, '134306689508165532', 23120, dir, alive)).toBe('gone');
  });

  it('is UNKNOWN — not gone — when the directory cannot be read', () => {
    // Descriptors are rewritten constantly. Treating one unreadable poll as
    // death permanently unsupervises a live session, with no way back.
    expect(checkSessionLiveness(ID, 'x', 23120, path.join(dir, 'nope'), alive)).toBe('unknown');
  });

  it('is UNKNOWN when the descriptor is briefly absent but the process lives', () => {
    expect(checkSessionLiveness(ID, 'x', process.pid, dir, alive)).toBe('unknown');
  });

  it('is gone when the descriptor is absent and the process is not running', () => {
    expect(checkSessionLiveness(ID, 'x', 2 ** 30, dir, dead)).toBe('gone');
  });
});

describe('sessionStillRunning', () => {
  it('is true only for a confirmed live interactive session', () => {
    writeDescriptor();
    expect(sessionStillRunning(ID, '134306689508165532', dir, alive)).toBe(true);
    expect(sessionStillRunning('other', null, dir, alive)).toBe(false);
  });
});

describe('pidAlive', () => {
  it('reports this process as alive and an impossible pid as dead', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 30)).toBe(false);
  });
});
