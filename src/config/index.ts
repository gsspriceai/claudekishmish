/**
 * User settings, their defaults, and the bounds that keep a hand-edited config
 * from turning the supervisor into a hazard.
 *
 * Both jobs are ON by default, which is the whole point of the tool: it should
 * work after `ckm setup` without a second decision.
 *
 *   - `autoContinue` continues work the user already started, in the terminal
 *     they started it in, with the permissions they already granted.
 *   - `idleClaim` sends a minimal request at a boundary that would otherwise
 *     pass unclaimed. This one spends quota with no task behind it, so although
 *     it is on, it is never silent: `ckm setup` says so, `ckm status` shows the
 *     running count, every claim is logged before it happens, and the weekly cap
 *     plus the weekly-limit suspension bound it from above. `ckm claim off`
 *     turns it off outright.
 */

import fs from 'node:fs';
import { configPath, ckmHome } from '../platform/paths.js';
import { MAX_CONTINUATION_LENGTH } from '../pty/inject.js';

export interface Config {
  /** Continue a wrapped session when its window reopens. */
  autoContinue: boolean;
  /** Send a minimal ping at an otherwise-unclaimed boundary. */
  idleClaim: boolean;
  /** Text typed into the session on resume. Fixed by config, never model-derived. */
  continuationText: string;
  /** Prompt used when a claim starts a brand-new throwaway session. */
  pingText: string;
  /** Fire this long after the boundary, so we are never a second early. */
  boundaryBufferMs: number;
  /**
   * How long to leave a boundary alone for the process that owns the pending
   * session's PTY, before anyone else may claim it.
   */
  resumeDeferGraceMs: number;
  /** How often the daemon and wrappers re-read shared state. */
  pollIntervalMs: number;
  /** Hard cap on automatic continuations per session. */
  maxResumesPerSession: number;
  /** Hard cap on idle claims in any rolling 7 days. */
  maxIdleClaimsPerWeek: number;
}

export const DEFAULT_CONFIG: Config = {
  autoContinue: true,
  idleClaim: true,
  continuationText: 'continue',
  pingText: 'ok',
  boundaryBufferMs: 20_000,
  resumeDeferGraceMs: 60_000,
  pollIntervalMs: 10_000,
  maxResumesPerSession: 3,
  maxIdleClaimsPerWeek: 14,
};

/**
 * Inclusive bounds for numeric settings.
 *
 * A negative buffer would make a boundary "due" before the window ends, sending
 * a request that must fail; a zero poll interval becomes a 1ms `setInterval`
 * that hammers the state lock. Both are reachable by editing the JSON.
 */
const BOUNDS: Partial<Record<keyof Config, { min: number; max: number }>> = {
  boundaryBufferMs: { min: 0, max: 30 * 60_000 },
  resumeDeferGraceMs: { min: 0, max: 30 * 60_000 },
  pollIntervalMs: { min: 1_000, max: 10 * 60_000 },
  maxResumesPerSession: { min: 0, max: 50 },
  maxIdleClaimsPerWeek: { min: 0, max: 100 },
};

/**
 * These are one-line messages; anything longer is a mistake or a paste
 * accident, and a long one is typed into a live terminal keystroke by
 * keystroke.
 *
 * The continuation limit is the injector's own, not a second opinion. They were
 * briefly different — 2000 here, 500 there — which meant a long continuation
 * passed every check, was written to disk, and was then refused at the one
 * moment it mattered: hours later, silently, with auto-continue simply never
 * happening.
 */
const MAX_CONTINUATION = MAX_CONTINUATION_LENGTH;
const MAX_PING = 200;

/**
 * Reduce a configured message to something safe to send as one message.
 *
 * Control characters are removed rather than escaped: there is no meaningful
 * way to type ESC or a carriage return into a TUI's input box, and both do
 * something — Enter submits, ESC begins an escape sequence.
 */
function singleLine(value: string, max: number, fallback: string): string {
  const stripped = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  // An empty message would submit a blank line into the user's session.
  return stripped === '' ? fallback : stripped;
}

/** Clamp numbers into range, drop anything of the wrong type, and make the two
 * message settings safe to send. */
export function sanitiseConfig(input: Partial<Config>): Config {
  const out: Config = { ...DEFAULT_CONFIG };
  for (const key of configKeys()) {
    const value = input[key];
    if (value === undefined) continue;
    const expected = typeof DEFAULT_CONFIG[key];
    if (typeof value !== expected) continue;

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      const bound = BOUNDS[key];
      const clamped = bound ? Math.min(bound.max, Math.max(bound.min, value)) : value;
      (out[key] as number) = clamped;
    } else {
      (out[key] as Config[keyof Config]) = value as Config[keyof Config];
    }
  }
  // Both of these are typed or passed as a single message, so a control
  // character in either is not cosmetic.
  //
  // A newline in `continuationText` is the dangerous one: Enter is *submit* in
  // Claude Code's input box, so "please\ncontinue" would send "please" on its
  // own and then type "continue" into a session that is already working —
  // exactly the interruption the draft guard exists to prevent, arriving from
  // the config file instead of from the user.
  out.continuationText = singleLine(out.continuationText, MAX_CONTINUATION, DEFAULT_CONFIG.continuationText);
  out.pingText = singleLine(out.pingText, MAX_PING, DEFAULT_CONFIG.pingText);
  return out;
}

export function loadConfig(): Config {
  try {
    return sanitiseConfig(JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<Config>);
  } catch {
    // Missing or corrupt config must never stop the tool; defaults are safe.
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(ckmHome(), { recursive: true });
  const tmp = `${configPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sanitiseConfig(config), null, 2) + '\n', 'utf8');
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
    const bound = BOUNDS[key];
    if (bound && (n < bound.min || n > bound.max)) {
      throw new Error(`${key} must be between ${bound.min} and ${bound.max}`);
    }
    return n;
  }
  return value;
}

export function configKeys(): (keyof Config)[] {
  return Object.keys(DEFAULT_CONFIG) as (keyof Config)[];
}

export { configPath };
