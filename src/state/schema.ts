/**
 * Shapes persisted to ~/.claudekishmish/state.json.
 *
 * Every field is plain JSON. Times are epoch milliseconds so that nothing in the
 * ledger depends on a timezone, a locale, or a monotonic clock that a laptop
 * suspend would invalidate.
 */

/** Which of Claude Code's three limits we are looking at. */
export type LimitKind = 'session' | 'weekly' | 'model';

/** A limit interruption we observed, already classified. */
export interface LimitEvent {
  kind: LimitKind;
  /** When we noticed it. */
  detectedAt: number;
  /**
   * Server-stated reset, absolute. `null` for `model` limits, which state no
   * reset time at all — waiting does not help there.
   */
  resetAt: number | null;
  /** The message we classified, kept verbatim for the audit log. */
  raw: string;
}

/** A Claude Code session we are supervising. */
export interface SupervisedSession {
  sessionId: string;
  pid: number;
  /**
   * Process start stamp from ~/.claude/sessions/<pid>.json. Guards against PID
   * reuse: a matching pid with a different procStart is a different process.
   */
  procStart: string | null;
  cwd: string;
  name: string;
  /** True when this process owns the session's PTY and can inject input. */
  ptyOwned: boolean;
  /** Per-session kill switch, set by `ckm pause`. */
  paused: boolean;
  /** Waiting on a boundary to continue. */
  pendingResume: boolean;
  /** How many times we have auto-continued this session. Capped. */
  resumeCount: number;
  limit: LimitEvent | null;
  registeredAt: number;
  updatedAt: number;
}

/** What we believe about the current usage window. */
export interface WindowLedger {
  /** Epoch ms of the current window's start, floored to the 10-minute grid. */
  currentStart: number | null;
  /** Epoch ms of the current window's end. */
  currentEnd: number | null;
  /**
   * The last boundary we claimed. Makes claiming idempotent when the daemon and
   * a wrapper race for the same boundary.
   */
  lastClaimedBoundary: number | null;
  /** Where `currentEnd` came from; a server-stated reset outranks our own math. */
  source: 'computed' | 'reset-message' | 'claim' | null;
}

/** Weekly-cap bookkeeping, so the tool never eats the budget it exists to protect. */
export interface WeeklyState {
  /** Idle claims are suspended until this time after a weekly limit is seen. */
  suspendedUntil: number | null;
  /** Epoch ms of each idle claim, trimmed to a rolling 7 days. */
  idleClaims: number[];
}

export interface State {
  version: 1;
  ledger: WindowLedger;
  /** Keyed by sessionId. */
  sessions: Record<string, SupervisedSession>;
  weekly: WeeklyState;
  /** Global kill switch, set by `ckm pause --all`. */
  globalPaused: boolean;
  updatedAt: number;
}

export function emptyState(now: number): State {
  return {
    version: 1,
    ledger: {
      currentStart: null,
      currentEnd: null,
      lastClaimedBoundary: null,
      source: null,
    },
    sessions: {},
    weekly: { suspendedUntil: null, idleClaims: [] },
    globalPaused: false,
    updatedAt: now,
  };
}
