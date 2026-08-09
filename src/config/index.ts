/**
 * User settings and their defaults.
 *
 * Defaults are chosen for safety, not for maximum effect:
 *
 *   - `autoContinue` is ON. It continues work the user already started, in the
 *     terminal they started it in, with the permissions they already granted.
 *   - `idleClaim` is OFF. It spends quota with no user intent behind it, so it
 *     must be an explicit choice (`ckm claim on`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { configPath, ckmHome } from '../platform/paths.js';

export interface Config {
  /** Continue a wrapped session when its window reopens. */
  autoContinue: boolean;
  /** Send a minimal ping at an otherwise-unclaimed boundary. Opt-in. */
  idleClaim: boolean;
  /** Text typed into the session on resume. Fixed by config, never model-derived. */
  continuationText: string;
  /** Prompt used for an idle claim. Kept trivially short on purpose. */
  pingText: string;
  /** Fire this long after the boundary, so we are never a second early. */
  boundaryBufferMs: number;
  /** How often the daemon and wrappers re-read shared state. */
  pollIntervalMs: number;
  /** Hard cap on automatic continuations per session. */
  maxResumesPerSession: number;
  /** Hard cap on idle claims in any rolling 7 days. */
  maxIdleClaimsPerWeek: number;
  /** Log every automatic action before performing it. */
  auditLog: boolean;
}

export const DEFAULT_CONFIG: Config = {
  autoContinue: true,
  idleClaim: false,
  continuationText: 'continue',
  pingText: 'ok',
  boundaryBufferMs: 20_000,
  pollIntervalMs: 10_000,
  maxResumesPerSession: 3,
  maxIdleClaimsPerWeek: 14,
  auditLog: true,
};

export function loadConfig(): Config {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    // Missing or corrupt config must never stop the tool; defaults are safe.
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(ckmHome(), { recursive: true });
  const tmp = configPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, configPath());
}

/** Coerce a CLI string into the type the given key expects. */
export function coerceConfigValue(key: keyof Config, value: string): Config[keyof Config] {
  const current = DEFAULT_CONFIG[key];
  if (typeof current === 'boolean') {
    if (['true', '1', 'on', 'yes'].includes(value.toLowerCase())) return true;
    if (['false', '0', 'off', 'no'].includes(value.toLowerCase())) return false;
    throw new Error(`${key} expects a boolean (true/false), got "${value}"`);
  }
  if (typeof current === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${key} expects a number, got "${value}"`);
    return n;
  }
  return value;
}

export function configKeys(): (keyof Config)[] {
  return Object.keys(DEFAULT_CONFIG) as (keyof Config)[];
}

export { configPath, path };
