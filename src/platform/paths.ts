/** Where everything lives, on every platform. */

import os from 'node:os';
import path from 'node:path';

/** Claude Code's own state directory. Same layout on Windows, macOS and Linux. */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

/** Live session descriptors, one JSON file per running process. */
export function claudeSessionsDir(): string {
  return path.join(claudeHome(), 'sessions');
}

/** Per-project conversation transcripts (`<project-slug>/<session-id>.jsonl`). */
export function claudeProjectsDir(): string {
  return path.join(claudeHome(), 'projects');
}

/** Our own state directory. Overridable, which is what the tests use. */
export function ckmHome(): string {
  return process.env.CKM_HOME ?? path.join(os.homedir(), '.claudekishmish');
}

export function statePath(): string {
  return path.join(ckmHome(), 'state.json');
}

export function configPath(): string {
  return path.join(ckmHome(), 'config.json');
}

export function logPath(): string {
  return path.join(ckmHome(), 'ckm.log');
}

export function daemonLockPath(): string {
  return path.join(ckmHome(), 'daemon.lock');
}

export function stateLockPath(): string {
  return path.join(ckmHome(), 'state.json.lock');
}
