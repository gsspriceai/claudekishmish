/**
 * Every user-turn timestamp on the machine, without re-reading the machine.
 *
 * The window has to be re-derived from transcript evidence on every tick — that
 * is the only thing that keeps the ledger honest — but a full scan here is
 * 885 MB across 94 files and takes about 1.6 seconds on a real install. At a
 * 10-second poll that is a sixth of the machine's time spent re-reading files
 * that did not change.
 *
 * Transcripts are append-only, so a file whose size and mtime are unchanged
 * cannot have gained a turn. Cache per file, keyed on both: mtime alone is too
 * coarse (filesystems round it, and two writes inside the same tick share it),
 * and size alone misses an edit that keeps the length. Together they are wrong
 * only if a file is rewritten to exactly its old length inside one timestamp
 * tick, which append-only writes never do.
 *
 * The cache lives in the process, not on disk. A stale cache that outlived the
 * daemon would be a silent source of a wrong window — the exact class of bug
 * this file exists to fix — and rebuilding it costs one scan at startup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectsDir } from '../platform/paths.js';
import { readRecords, userTurnTimes } from './transcript.js';

interface CacheEntry {
  mtimeMs: number;
  size: number;
  times: number[];
}

export interface ScanStats {
  /** Files whose contents were parsed this scan. */
  read: number;
  /** Files served from the cache without touching their contents. */
  cached: number;
}

const cache = new Map<string, CacheEntry>();
let lastStats: ScanStats = { read: 0, cached: 0 };

/** What the previous scan actually had to do. Exposed for the log and tests. */
export function lastScanStats(): ScanStats {
  return { ...lastStats };
}

/** Drop everything. Tests use this; nothing in the product needs it. */
export function clearTurnCache(): void {
  cache.clear();
  lastStats = { read: 0, cached: 0 };
}

function transcriptFiles(root: string): string[] {
  const out: string[] = [];
  let projects: string[];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const project of projects) {
    const dir = path.join(root, project);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      // A project directory can vanish between the two reads.
      continue;
    }
    for (const file of files) {
      if (file.endsWith('.jsonl')) out.push(path.join(dir, file));
    }
  }
  return out;
}

/**
 * Every user-turn timestamp across every transcript, ascending.
 *
 * Same answer as a full scan, at the cost of one `stat` per file once the cache
 * is warm.
 */
export function cachedUserTurnTimes(root = claudeProjectsDir()): number[] {
  const files = transcriptFiles(root);
  const seen = new Set<string>();
  const times: number[] = [];
  let read = 0;
  let cached = 0;

  for (const file of files) {
    seen.add(file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      // Deleted mid-scan. Its cached turns are dropped below with the file.
      continue;
    }

    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      cached++;
      times.push(...hit.times);
      continue;
    }

    const parsed = userTurnTimes(readRecords(file));
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, times: parsed });
    read++;
    times.push(...parsed);
  }

  // Forget files that no longer exist, so a long-lived daemon does not hold
  // every transcript the user ever deleted.
  for (const known of [...cache.keys()]) {
    if (!seen.has(known)) cache.delete(known);
  }

  lastStats = { read, cached };
  return times.sort((a, b) => a - b);
}
