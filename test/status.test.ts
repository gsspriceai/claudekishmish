/**
 * What `ckm status` tells you.
 *
 * This is the only window a user has into a process that acts while they are
 * asleep, so what it reports — and what it silently leaves out — is behaviour,
 * not presentation. Nothing here had a test before; the outage line is added
 * with one because a session stalled by an outage and a session stalled by a
 * limit look identical from outside, and lead to completely different
 * expectations about when work resumes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { statusReport } from '../src/cli/commands/status.js';
import { mutateState } from '../src/state/store.js';
import { emptyState, type SupervisedSession } from '../src/state/schema.js';

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-status-'));
  process.env.CKM_HOME = home;
});

afterEach(() => {
  delete process.env.CKM_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function session(over: Partial<SupervisedSession> = {}): SupervisedSession {
  const now = Date.now();
  return {
    sessionId: ID,
    pid: process.pid,
    procStart: 'stamp',
    cwd: '/repo',
    name: 'repo',
    ptyOwned: true,
    sessionStatus: 'idle',
    hasDraftInput: false,
    supervisedFrom: now - 60_000,
    paused: false,
    pendingResume: false,
    resumeCount: 0,
    limit: null,
    outage: null,
    missedLivenessChecks: 0,
    registeredAt: now - 60_000,
    updatedAt: now,
    ...over,
  };
}

const report = () => statusReport().join('\n');

describe('ckm status, with a session stalled by an outage', () => {
  it('names the outage, the attempts used, and when it will try again', async () => {
    const now = Date.now();
    await mutateState(() => ({
      ...emptyState(now),
      sessions: {
        [ID]: session({
          pendingResume: true,
          outage: {
            detectedAt: now - 10_000,
            status: 529,
            error: 'unknown',
            raw: 'API Error: Overloaded',
            attempts: 2,
            retryAt: now + 120_000,
          },
        }),
      },
    }));

    const out = report();
    expect(out).toContain('API Error: Overloaded');
    // The count matters: "it is still trying" and "it has given up" are the two
    // things a person actually wants to know.
    expect(out).toMatch(/retry 2\/\d+/);
  });

  it('says nothing about outages when there are none', async () => {
    await mutateState(() => ({ ...emptyState(Date.now()), sessions: { [ID]: session() } }));
    expect(report()).not.toContain('outage');
  });

  it('reports a session with no supervised sessions at all', async () => {
    await mutateState(() => emptyState(Date.now()));
    expect(report()).toContain('Supervised sessions (0)');
  });

  it('leads with a halt, rather than burying it', async () => {
    // A halted tool that looks healthy is the worst possible status screen.
    const now = Date.now();
    await mutateState(() => ({
      ...emptyState(now),
      halted: {
        reason: 'subscription' as const,
        detectedAt: now,
        detail: 'subscription ended',
        expiresAt: null,
      },
    }));

    const lines = statusReport();
    const haltIndex = lines.findIndex((l) => l.includes('HALTED'));
    const windowIndex = lines.findIndex((l) => l.includes('Window'));
    expect(haltIndex).toBeGreaterThanOrEqual(0);
    expect(haltIndex).toBeLessThan(windowIndex);
  });
});
