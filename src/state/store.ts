/**
 * Lock-protected state file.
 *
 * This is the whole coordination layer. The daemon and every wrapper
 * read-modify-write the same JSON under an exclusive lock; there is no socket,
 * no named pipe, and therefore no per-platform IPC to get wrong. Boundaries land
 * on a 10-minute grid, so a lock held for a few milliseconds and a poll measured
 * in seconds are both far more precision than the problem needs.
 *
 * The lock is an exclusively-created file (`wx`), which is atomic on Windows,
 * macOS and Linux alike. Locks left behind by a killed process are reclaimed
 * once they go stale.
 */

import fs from 'node:fs';
import { statePath, stateLockPath, ckmHome } from '../platform/paths.js';
import { emptyState, type State } from './schema.js';

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;

function sleepSync(ms: number): void {
  // Deliberately synchronous: the critical section is tiny and making it async
  // would let two ticks of the same process interleave inside the lock.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockIsStale(): boolean {
  try {
    const stat = fs.statSync(stateLockPath());
    return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function acquireLock(): void {
  fs.mkdirSync(ckmHome(), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(stateLockPath(), 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      if (lockIsStale()) {
        try {
          fs.unlinkSync(stateLockPath());
        } catch {
          /* another process reclaimed it first */
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for the claudekishmish state lock');
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function releaseLock(): void {
  try {
    fs.unlinkSync(stateLockPath());
  } catch {
    /* already gone */
  }
}

/** Read state without locking. Fine for display; never for read-modify-write. */
export function readState(): State {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as State;
    if (parsed && parsed.version === 1) {
      // Tolerate files written by an older build that lacked a field.
      return { ...emptyState(Date.now()), ...parsed };
    }
    return emptyState(Date.now());
  } catch {
    // Missing or corrupt state is not an error: we simply have no history yet.
    return emptyState(Date.now());
  }
}

function writeStateUnlocked(state: State): void {
  fs.mkdirSync(ckmHome(), { recursive: true });
  const tmp = statePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, statePath());
}

/**
 * Atomically transform the state.
 *
 * The mutator receives the current state and returns the next one. It runs
 * inside the lock, so it must not perform slow I/O — decide first, then act on
 * the decision after this returns.
 */
export function updateState<T>(mutate: (state: State) => { next: State; result: T }): T {
  acquireLock();
  try {
    const current = readState();
    const { next, result } = mutate(current);
    next.updatedAt = Date.now();
    writeStateUnlocked(next);
    return result;
  } finally {
    releaseLock();
  }
}

/** Convenience wrapper for mutations with nothing to report back. */
export function mutateState(mutate: (state: State) => State): void {
  updateState((s) => ({ next: mutate(s), result: undefined }));
}

/** Test-only: wipe state so a suite starts from a known point. */
export function resetStateForTests(): void {
  releaseLock();
  try {
    fs.unlinkSync(statePath());
  } catch {
    /* nothing to remove */
  }
}
