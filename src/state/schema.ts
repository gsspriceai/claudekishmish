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
  /**
   * Claude Code's own view of the session, from its descriptor: `idle`, `busy`,
   * `shell`. Shown by `ckm status` so the user can see what we see.
   */
  sessionStatus: string | null;
  /**
   * True when the user has typed something they have not submitted. Injecting
   * then would append to their draft and press Enter, submitting a half-written
   * message. Only the PTY owner can know this, so only it sets the flag.
   */
  hasDraftInput: boolean;
  /**
   * When this supervisor took charge. Limits recorded *before* this are history
   * belonging to an earlier run of the same session id — acting on them would
   * type into a terminal the user just opened.
   */
  supervisedFrom: number;
  /** Per-session kill switch, set by `ckm pause`. */
  paused: boolean;
  /** Waiting on a boundary to continue. */
  pendingResume: boolean;
  /** How many times we have auto-continued this session. Capped. */
  resumeCount: number;
  limit: LimitEvent | null;
  /**
   * Consecutive liveness checks that failed. A session descriptor is rewritten
   * constantly by Claude Code, so a single unreadable read is normal and must
   * not unsupervise a live session.
   */
  missedLivenessChecks: number;
  registeredAt: number;
  updatedAt: number;
}

/**
 * A boundary held by one actor while it tries to act on it.
 *
 * Reserving is not claiming. A reservation is released if the actor cannot act
 * or fails, so a boundary is never consumed by something that did not send a
 * request. Expiry covers the actor dying mid-attempt.
 */
export interface BoundaryReservation {
  boundary: number;
  /** Identifies the reserving process; only the owner may convert or release. */
  owner: string;
  expiresAt: number;
}

/** What we believe about the current usage window. */
export interface WindowLedger {
  /** Epoch ms of the current window's start, floored to the 10-minute grid. */
  currentStart: number | null;
  /** Epoch ms of the current window's end. */
  currentEnd: number | null;
  /**
   * The last boundary actually claimed by a request that landed. Makes claiming
   * idempotent when the daemon and a wrapper race for the same boundary.
   */
  lastClaimedBoundary: number | null;
  /** In-flight attempt on the next boundary, if any. */
  reservation: BoundaryReservation | null;
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

/**
 * A stop that retrying cannot clear.
 *
 * If the account is logged out, the subscription has ended, or the credentials
 * are rejected, every future request will fail the same way. Continuing to ping
 * would be pointless noise, so the tool halts and says so.
 *
 * Some halts clear themselves — see `expiresAt`.
 */
export interface HaltState {
  reason: 'auth' | 'subscription' | 'model' | 'unknown';
  detectedAt: number;
  detail: string;
  /**
   * When the halt lifts by itself, or `null` if only a human can clear it.
   *
   * A per-model cap clears on its own, so making the user notice a line in
   * `ckm status` and type a command would strand the tool for no reason. A
   * logged-out account will not fix itself, so that one waits for a person.
   */
  expiresAt: number | null;
}

export interface State {
  version: 1;
  ledger: WindowLedger;
  /** Keyed by sessionId. */
  sessions: Record<string, SupervisedSession>;
  weekly: WeeklyState;
  /** Global kill switch, set by `ckm pause --all`. */
  globalPaused: boolean;
  /** Set when a terminal failure makes further requests futile. */
  halted: HaltState | null;
  updatedAt: number;
}

export function emptyState(now: number): State {
  return {
    version: 1,
    ledger: {
      currentStart: null,
      currentEnd: null,
      lastClaimedBoundary: null,
      reservation: null,
      source: null,
    },
    sessions: {},
    weekly: { suspendedUntil: null, idleClaims: [] },
    globalPaused: false,
    halted: null,
    updatedAt: now,
  };
}
