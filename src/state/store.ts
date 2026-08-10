/**
 * Lock-protected state file.
 *
 * This is the whole coordination layer. The daemon and every wrapper
 * read-modify-write the same JSON under an exclusive lock; there is no socket,
 * no named pipe, and therefore no per-platform IPC to get wrong.
 *
 * Two properties matter and both were learned the hard way:
 *
 *   - **The lock must not block the event loop.** A wrapper is pumping a live
 *     PTY; a synchronous spin would freeze the user's terminal for as long as
 *     the lock is contended. Waiting is therefore `await`, not `Atomics.wait`.
 *   - **The critical section must be short.** It holds no I/O beyond this file.
 *     Callers read transcripts *before* taking the lock and pass the result in.
 *
 * The lock is an exclusively-created file (`wx`), atomic on Windows, macOS and
 * Linux alike, whose mtime is refreshed while held so a slow section is never
 * mistaken for an abandoned one.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { statePath, stateLockPath, ckmHome } from '../platform/paths.js';
import { emptyState, type State } from './schema.js';
import { logWarn } from '../logger/index.js';

const LOCK_STALE_MS = 15_000;
const LOCK_HEARTBEAT_MS = 3_000;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A held lock, with the heartbeat that keeps it from looking stale. */
interface HeldLock {
  heartbeat: NodeJS.Timeout;
}

async function lockIsStale(): Promise<boolean> {
  try {
    const stat = await fsp.stat(stateLockPath());
    return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function acquireLock(): Promise<HeldLock> {
  await fsp.mkdir(ckmHome(), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      const handle = await fsp.open(stateLockPath(), 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();

      // Refresh the mtime while we hold it: a section that legitimately runs
      // long must never be reclaimed out from under itself, because the
      // reclaiming process would then delete *our* lock on its way out.
      const heartbeat = setInterval(() => {
        const now = new Date();
        try {
          fs.utimesSync(stateLockPath(), now, now);
        } catch {
          /* released underneath us; nothing to refresh */
        }
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();

      return { heartbeat };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      if (await lockIsStale()) {
        try {
          await fsp.unlink(stateLockPath());
        } catch {
          /* another process reclaimed it first */
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for the claudekishmish state lock');
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function releaseLock(held: HeldLock): Promise<void> {
  clearInterval(held.heartbeat);
  try {
    // Only if it is still ours. After a stale reclaim the lock belongs to
    // someone else, and deleting theirs would hand the file to a third process.
    const owner = await fsp.readFile(stateLockPath(), 'utf8');
    if (owner.trim() !== String(process.pid)) return;
    await fsp.unlink(stateLockPath());
  } catch {
    /* already gone, or not readable — leave it for the staleness sweep */
  }
}

function parseState(raw: string): State {
  const parsed = JSON.parse(raw) as State;
  if (!parsed || parsed.version !== 1) throw new Error('unrecognised state version');
  // Tolerate files written by an older build that lacked a field.
  const base = emptyState(Date.now());
  return { ...base, ...parsed, ledger: { ...base.ledger, ...parsed.ledger } };
}

/**
 * Read state without locking. Fine for display; never for read-modify-write.
 *
 * The three cases are deliberately not the same:
 *
 *   - **no file** is normal — there is simply no history yet;
 *   - **unreadable JSON** is recoverable, but it must be visible: the file is
 *     set aside as `state.json.corrupt` and a warning logged, because silently
 *     starting from nothing discards an active halt and the weekly claim
 *     count, and the very next tick then spends a request the halt existed to
 *     prevent;
 *   - **any other I/O error** (EPERM or EBUSY, routine on Windows during the
 *     concurrent rename below, or under antivirus) is *not* evidence of an
 *     empty state and must not be treated as one. It throws, so the caller
 *     retries on the next poll instead of overwriting everything with defaults.
 */
export function readState(): State {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(Date.now());
    throw err;
  }

  try {
    return parseState(raw);
  } catch {
    quarantineCorruptState();
    return emptyState(Date.now());
  }
}

/** Move an unparsable state file aside so the loss is recoverable and obvious. */
function quarantineCorruptState(): void {
  const bad = `${statePath()}.corrupt`;
  try {
    fs.renameSync(statePath(), bad);
  } catch {
    /* best effort */
  }
  logWarn('state.corrupt', {
    movedTo: bad,
    note: 'starting from empty state; any halt and the weekly claim count were lost',
  });
}

async function writeStateUnlocked(state: State): Promise<void> {
  await fsp.mkdir(ckmHome(), { recursive: true });
  const tmp = `${statePath()}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, statePath());
}

/**
 * Atomically transform the state.
 *
 * The mutator runs inside the lock and must be synchronous and fast: decide
 * here, then act on the returned decision after this resolves.
 */
export async function updateState<T>(
  mutate: (state: State) => { next: State; result: T },
): Promise<T> {
  const held = await acquireLock();
  try {
    const current = readState();
    const { next, result } = mutate(current);

    // Most ticks change nothing. Writing anyway meant a lock, a temp file and a
    // rename every ten seconds per process, all day, for an unchanged 1 KB file.
    const before = JSON.stringify({ ...current, updatedAt: 0 });
    const after = JSON.stringify({ ...next, updatedAt: 0 });
    if (before === after) return result;

    next.updatedAt = Date.now();
    await writeStateUnlocked(next);
    return result;
  } finally {
    await releaseLock(held);
  }
}

/** Convenience wrapper for mutations with nothing to report back. */
export async function mutateState(mutate: (state: State) => State): Promise<void> {
  await updateState((s) => ({ next: mutate(s), result: undefined }));
}

/** Test-only: wipe state so a suite starts from a known point. */
export function resetStateForTests(): void {
  for (const p of [statePath(), stateLockPath()]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* nothing to remove */
    }
  }
}
