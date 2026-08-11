/**
 * Read Claude Code conversation transcripts.
 *
 * Transcripts are append-only JSONL at
 * `~/.claude/projects/<project-slug>/<session-id>.jsonl`. They are the
 * authoritative source for two things:
 *
 *   1. limit interruptions — the `rate_limit` error record, which carries the
 *      server-stated reset time;
 *   2. window derivation — the timestamp of the first message after the previous
 *      window expired, which is what anchors the current window.
 *
 * PTY output is only ever an early trigger. Decisions come from here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectsDir } from '../platform/paths.js';
import { toLimitEvent, type TranscriptRecord } from './limits.js';
import { toOutageEvent, type OutageEvent } from './outage.js';
import type { LimitEvent } from '../state/schema.js';

/** Locate the transcript for a session id, searching every project directory. */
export function findTranscript(sessionId: string, root = claudeProjectsDir()): string | null {
  let projects: string[];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = path.join(root, project, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Parse a JSONL file into records, tolerating partial trailing writes. */
function parseLines(text: string): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as TranscriptRecord);
    } catch {
      // The last line may be mid-write; skip it and catch it next poll.
    }
  }
  return out;
}

export function readRecords(file: string): TranscriptRecord[] {
  try {
    return parseLines(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Read only what was appended since `offset`.
 *
 * Transcripts reach tens of megabytes, so a supervisor that re-read the whole
 * file every ten seconds would be a problem all by itself.
 */
export function readSince(
  file: string,
  offset: number,
): { records: TranscriptRecord[]; offset: number } {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { records: [], offset };
  }
  // A shrunken file means it was rotated or replaced; start over.
  const from = offset > size ? 0 : offset;
  if (from === size) return { records: [], offset: size };

  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { records: [], offset: from };
  }

  // Stop at the last complete line so a half-written record is re-read later.
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) return { records: [], offset: from };

  return {
    records: parseLines(text.slice(0, lastNewline)),
    offset: from + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8'),
  };
}

/** The most recent limit interruption in a set of records, if any. */
export function latestLimitEvent(records: TranscriptRecord[], now = new Date()): LimitEvent | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const event = toLimitEvent(records[i]!, now);
    if (event) return event;
  }
  return null;
}

/**
 * The most recent retryable API outage in a set of records, if any.
 *
 * Scanned newest-first like limits: only the latest failure matters, because an
 * older one has either been recovered from or is the same outage still running.
 */
export function latestOutageEvent(
  records: TranscriptRecord[],
  backoffMs: number,
  now = new Date(),
): OutageEvent | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const event = toOutageEvent(records[i]!, now, backoffMs);
    if (event) return event;
  }
  return null;
}

/** Every user-turn timestamp in a transcript, ascending. */
export function userTurnTimes(records: TranscriptRecord[]): number[] {
  const out: number[] = [];
  for (const record of records) {
    if (record.type !== 'user' || !record.timestamp) continue;
    const t = Date.parse(record.timestamp);
    if (Number.isFinite(t)) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

/** Every user-turn timestamp across every transcript on the machine, ascending. */
export function allUserTurnTimes(root = claudeProjectsDir()): number[] {
  const times: number[] = [];
  let projects: string[];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return [];
  }
  for (const project of projects) {
    const dir = path.join(root, project);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      times.push(...userTurnTimes(readRecords(path.join(dir, file))));
    }
  }
  return times.sort((a, b) => a - b);
}
