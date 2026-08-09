/**
 * Global test setup.
 *
 * Every test file gets its own throwaway state directory, whether it asks for
 * one or not. Without this, any test that reaches the logger writes into the
 * user's real `~/.claudekishmish/ckm.log` — which is exactly what happened, and
 * was only noticed because real log entries turned up next to a live run.
 *
 * Files that manage their own `CKM_HOME` still override this freely; this only
 * guarantees the default is never the real one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';

let sandbox: string;

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-test-sandbox-'));
  process.env.CKM_HOME = sandbox;
});

afterAll(() => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
