import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findTranscript,
  latestLimitEvent,
  readRecords,
  readSince,
  userTurnTimes,
} from '../src/claude/transcript.js';
import { rateLimitRecord, REAL_RESET_STRINGS, userTurn } from './fixtures/real-records.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-transcript-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeTranscript(sessionId: string, records: unknown[], project = 'proj-a'): string {
  const dir = path.join(root, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

describe('findTranscript', () => {
  it('finds a transcript in any project directory', () => {
    writeTranscript('abc', [userTurn('2026-08-09T09:08:00.000Z')], 'proj-b');
    expect(findTranscript('abc', root)).toContain('abc.jsonl');
  });

  it('returns null when there is none', () => {
    expect(findTranscript('missing', root)).toBeNull();
  });
});

describe('readRecords', () => {
  it('skips a truncated trailing line rather than throwing', () => {
    const dir = path.join(root, 'p');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, JSON.stringify(userTurn('2026-08-09T09:00:00.000Z')) + '\n{"type":"us', 'utf8');
    expect(readRecords(file)).toHaveLength(1);
  });
});

describe('readSince', () => {
  it('returns only what was appended', () => {
    const file = writeTranscript('s1', [userTurn('2026-08-09T09:00:00.000Z')]);
    const first = readSince(file, 0);
    expect(first.records).toHaveLength(1);

    fs.appendFileSync(file, JSON.stringify(userTurn('2026-08-09T09:10:00.000Z')) + '\n');
    const second = readSince(file, first.offset);
    expect(second.records).toHaveLength(1);
    expect(second.offset).toBeGreaterThan(first.offset);
  });

  it('starts over when the file shrinks', () => {
    const file = writeTranscript('s2', [userTurn('2026-08-09T09:00:00.000Z')]);
    const result = readSince(file, 999_999);
    expect(result.records).toHaveLength(1);
  });

  it('holds back a half-written final line until it is complete', () => {
    const dir = path.join(root, 'p');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, JSON.stringify(userTurn('2026-08-09T09:00:00.000Z')) + '\n', 'utf8');

    const first = readSince(file, 0);
    fs.appendFileSync(file, '{"type":"user","timesta');
    const second = readSince(file, first.offset);
    expect(second.records).toHaveLength(0);
    // The offset must not advance past the incomplete line.
    expect(second.offset).toBe(first.offset);
  });
});

describe('latestLimitEvent', () => {
  it('returns the most recent limit, not the first', () => {
    const records = [
      rateLimitRecord(REAL_RESET_STRINGS[0], '2026-07-01T14:43:00.000Z'),
      userTurn('2026-07-01T15:00:00.000Z'),
      rateLimitRecord(REAL_RESET_STRINGS[3], '2026-07-01T18:43:00.000Z'),
    ];
    const event = latestLimitEvent(records)!;
    expect(event.detectedAt).toBe(Date.parse('2026-07-01T18:43:00.000Z'));
  });

  it('is null when there is no limit at all', () => {
    expect(latestLimitEvent([userTurn('2026-08-09T09:00:00.000Z')])).toBeNull();
  });
});

describe('userTurnTimes', () => {
  it('extracts and sorts user turns only', () => {
    const times = userTurnTimes([
      userTurn('2026-08-09T09:10:00.000Z'),
      rateLimitRecord(REAL_RESET_STRINGS[0], '2026-08-09T09:05:00.000Z'),
      userTurn('2026-08-09T09:00:00.000Z'),
    ]);
    expect(times).toEqual([
      Date.parse('2026-08-09T09:00:00.000Z'),
      Date.parse('2026-08-09T09:10:00.000Z'),
    ]);
  });
});
