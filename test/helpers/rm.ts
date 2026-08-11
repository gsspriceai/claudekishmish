/**
 * Remove a directory a child process was just using.
 *
 * `kill()` returns when the signal is delivered, not when the process is gone,
 * and on Windows a directory cannot be removed while any process still holds it
 * open — as a working directory, or with a write in flight. A prompt `rmSync`
 * then fails with EBUSY or ENOTEMPTY.
 *
 * That produces an intermittently red suite caused entirely by cleanup, which is
 * worse than no cleanup at all: it teaches you to re-run rather than to read the
 * failure, and the next real regression gets the same shrug.
 *
 * Retry briefly, then give up quietly. These directories live under the OS temp
 * root, which the OS reclaims on its own.
 */

import fs from 'node:fs';

export async function rmWhenReleased(target: string, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
