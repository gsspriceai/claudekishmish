# claudekishmish — original design record

**Written 2026-08-09, before implementation. Kept as a record of how the window
model was derived, not as documentation of current behaviour.**

Several decisions here were later reversed by measurement, and the code is the
authority — see `README.md`. The notable reversals:

- **`--bare` (§4.1)** — it cannot authenticate a subscription account ("OAuth and
  keychain are never read", in the flag's own help), so every claim failed with
  `Not logged in`. Replaced with flags that trim context without touching auth.
- **"a claim is a few hundred tokens" (§4.1)** — measured at ~22k cached-read
  tokens. Trying to shrink it further costs *more*, by missing the prompt cache.
- **The claim rule (§4)** — a boundary is now *reserved* by an owner and only
  becomes a claim once a request actually lands. Marking it claimed at decision
  time let an actor that could not act consume it, silently.
- **Windows autostart** — `schtasks /SC ONLOGON` needs elevation; the Startup
  folder does not.
- **`--no-session-persistence`** — a claim made with it left no transcript, so
  the next process could not see that the boundary had been claimed and the
  ledger was blind overnight. The claim now persists a session like any other.
- **Idle claiming off by default** — reversed on the user's instruction: both
  jobs are on after `ckm setup`, because a tool that needs a second decision to
  do its job does not do its job. It stays bounded by a weekly cap and is
  announced at setup, in `ckm status`, and in the log before each claim.
- **Resume gated on a boundary** — resuming and claiming a boundary are now
  separate decisions. Tying them together stranded a second waiting session,
  which had a limit of its own to recover from and no boundary to ride in on.
- **Nudging an already-open session (never shipped)** — built, then removed at
  the user's direction: an open session may hold work in progress, and a new
  throwaway session claims the boundary just as well without touching it.
- **Codex support (never shipped)** — dropped after measurement. Codex's window
  slides: `resets_at` is recomputed as `now + window` on every message, so there
  is no fixed boundary to claim and nothing for this tool to do.
- **The ledger advancing by its own claims (§4)** — reversed after a live
  failure. Every claim was assumed to open a new window, which is only true when
  the claim is the first message after the previous window expired. A claim
  landing mid-window described a window that did not exist, and each later claim
  re-anchored on the last wrong one. The ledger is now re-derived from transcript
  history every tick; §2's model was right, it was simply applied to an
  assumption instead of to evidence.
- **"the ledger never walks backwards"** — kept for stale reads, dropped for
  corrections. An observation whose window contains *now* is a statement about
  the present and outranks anything inferred, even when it moves the end
  earlier; one whose window has already ended is still ignored.

- **"transient API errors are out of scope"** — reversed 2026-08-11. The design
  treated only usage limits as interruptions worth continuing, on the grounds
  that everything else is rare. It is not rare enough: a 529, a stalled stream
  or a dropped socket stops the session exactly as a limit does, and states no
  reset time, so the wait is a bounded backoff rather than a stated time. It
  reuses the limit path so every safety guard applies unchanged.

What has held up, and is worth reading for: the derivation of the window model
in §2 from 90 real `rate_limit` records, and the reasoning in §2.3 about why
continuing a session in place requires owning its PTY.

---

**Date:** 2026-08-09
**Status:** Approved for implementation

Keep a Claude Code usage window always running, and continue interrupted work in
the terminal it was interrupted in.

---

## 1. Problem

Two separate losses happen around Claude Code's 5-hour usage windows.

**Loss 1 — unclaimed boundaries.** A usage window is 5 hours long and starts at
your *first message*. It only advances when someone claims it. If a window
expires at 02:00 and you send nothing until 09:00, those seven hours are dead
time: no window was running, so no allowance accrued to you.

**Loss 2 — stalled work.** When a window is exhausted mid-task, the session stops.
The window reopens at, say, 02:00, but the person is asleep. The task sits idle
until they wake up and type `continue`.

Measured on the author's own history (14,567 turns, 51 transcripts, 2026-06-21 →
2026-08-09): **62 of 71 window boundaries went unclaimed.** Only 9 were tiled
back-to-back.

## 2. Verified model

These are not assumptions. They were derived from 90 authoritative `rate_limit`
records in local session transcripts.

```
windowStart = floor10(first message after the previous window expired)
windowEnd   = windowStart + 5h
```

where `floor10(t)` rounds `t` down to a 10-minute grid.

Evidence: reset times parsed from every real limit message land on
`{:00, :10, :20, :30, :40, :50}` with **zero exceptions**. Predicting `windowEnd`
from the first message matched the server-stated reset in **9 of 9** testable
cases:

| First turn | floor10 | Predicted | Actual |
|---|---|---|---|
| 18:32 | 18:30 | 23:30 | 23:30 |
| 15:29 | 15:20 | 20:20 | 20:20 |
| 06:57 | 06:50 | 11:50 | 11:50 |
| 09:08 | 09:00 | 14:00 | 14:00 |
| 14:53 | 14:50 | 19:50 | 19:50 |

Because boundaries are on a 10-minute grid, second-level timing precision is
unnecessary. A 10-second poll is ample.

### 2.1 Three limit types

| Type | Message | Reset info | Handling |
|---|---|---|---|
| Session | `You've hit your session limit · resets 11:30pm (Asia/Calcutta)` | time | **wait + resume** |
| Weekly | `You've hit your weekly limit · resets Aug 6, 10:30pm (Asia/Calcutta)` | date + time | park, notify, suspend idle claims |
| Model | `You've reached your Fable 5 limit. Run /usage-credits to continue or switch models` | none | **out of scope** — detect, stop supervising, hand back |

"Out of scope" for the model limit means *detect and exit cleanly*, never *ignore
and hang forever*.

### 2.2 Detection signal

The transcript record is authoritative and machine-readable:

```json
{ "type": "assistant", "error": "rate_limit", "isApiErrorMessage": true,
  "apiErrorStatus": 429,
  "message": { "content": [{ "type": "text",
    "text": "You've hit your session limit · resets 11:30pm (Asia/Calcutta)" }] } }
```

PTY output is used only as an early trigger. Decisions come from the transcript.

### 2.3 Live terminal sessions

`~/.claude/sessions/<pid>.json` exists for every running session, on all three
platforms:

```json
{ "pid": 23120, "sessionId": "98399394-864e-4a9a-82bb-f81f42df5e16",
  "cwd": "C:\\work\\my-project", "kind": "interactive", "entrypoint": "cli",
  "name": "my-project-a1", "status": "busy", "procStart": "134306689508165532" }
```

A session is *open in a terminal* when `kind === "interactive"`, its PID is alive,
and `procStart` still matches (guards against PID reuse).

No supported mechanism exists to inject input into a TUI owned by another
process. `-r`, `-c`, `--fork-session`, `--teleport` and `claude agents` all start
a **new** process. Claude Code's internal daemon IPC (named pipes, `control.key`,
`roster.json`) is undocumented and version-fragile: **explicit non-goal**.

Therefore continuing a session *in place* requires owning its PTY.

## 3. Architecture

One npm package, three roles, coordinating through files. **No custom IPC.**

| Role | Responsibility | Lifetime |
|---|---|---|
| `ckm wrap` | PTY host. Runs real `claude` in a PTY, transparent passthrough, injects continuation on reset. | One per wrapped session |
| `ckm daemon` | Owns the window ledger. Claims boundaries when no wrapper will. | Long-lived, background |
| `ckm` | `status`, `pause`, `resume`, `setup`, `doctor`, `logs`, `config` | Interactive |

State lives in `~/.claudekishmish/`:

```
state.json     window ledger + session registry  (lock-protected)
config.json    user settings
ckm.log        append-only audit log
daemon.lock    single-daemon guard
```

Coordination is a lock-protected read-modify-write on `state.json`, polled every
10 seconds. Chosen over sockets because named pipes (Windows) vs Unix domain
sockets is the single largest cross-platform risk, and the 10-minute boundary
grid makes sub-second coordination pointless.

### 3.1 Modules

```
src/
  cli/            wrap · daemon · status · pause · resume · setup · doctor · logs · config
  pty/
    host.ts       node-pty spawn, resize, signal passthrough
    inject.ts     write continuation into PTY stdin
  claude/
    sessions.ts   ~/.claude/sessions/*.json → live interactive sessions
    transcript.ts tail ~/.claude/projects/**/<id>.jsonl
    limits.ts     rate_limit record → SESSION | WEEKLY | MODEL
    resetparse.ts "resets 11:30pm (Asia/Calcutta)" → absolute Date
    locate.ts     find the real `claude` binary, bypassing our own shim
  window/
    ledger.ts     floor10 · +5h · boundary math          (pure)
    claimer.ts    resume-vs-ping decision                (pure)
    ping.ts       minimal `claude -p` claim  (--bare: superseded)
  state/store.ts  lock-protected JSON read-modify-write
  config/         defaults + load/save
  logger/         append-only JSONL audit log
  platform/
    paths.ts      per-OS directories
    service.ts    launchd · systemd · Task Scheduler
    shell.ts      shim install for bash · zsh · fish · PowerShell
```

`ledger.ts` and `claimer.ts` are pure functions of `(state, now)`. All correctness
lives there and is unit-testable without Claude, without a PTY, and without real
time. Everything else is I/O plumbing.

### 3.2 Native dependency

`node-pty` is a native module. It is an **optional** dependency. If it fails to
install or load, `ckm wrap` degrades gracefully: it still supervises and still
claims boundaries, but reports that in-place continuation is unavailable rather
than failing. Install never hard-fails because of it.

## 4. The claim rule

A window boundary must be claimed **exactly once**, by exactly one actor.

```
at boundary + 20s:
  if a supervised session is paused        -> skip it
  if a supervised session has pending work -> inject continuation into the first  (this claims the window)
  else if idleClaim enabled                -> send a minimal --bare ping           (claims the window)
  else                                     -> do nothing, re-arm
```

Resuming *is* claiming. Never do both — that burns tokens for no gain.

`state.lastClaimedBoundary` makes this idempotent. Wrapper and daemon can race;
the lock plus the boundary stamp resolves it.

### 4.1 The ping must be tiny

> **Superseded.** `--bare` cannot authenticate a subscription account, so
> every claim failed with `Not logged in`. See the reversals at the top.

The idle claim runs with `--bare`, which skips hooks, LSP, plugin sync,
attribution, auto-memory, background prefetches, keychain reads, and CLAUDE.md
discovery. Without it, a claim loads the full project context — tens of thousands
of tokens, roughly five times a day. With it, a claim is a few hundred tokens.
This detail decides whether the feature is free or expensive.

## 5. Safety

Non-negotiable properties:

1. **Never escalate permissions.** The resumed session keeps exactly the flags it
   was launched with. `claudekishmish` never adds `--dangerously-skip-permissions`
   or widens `--permission-mode`.
2. **Caps.** `maxResumesPerSession` (default 3) and `maxIdleClaimsPerWeek`
   (default 14). Exceeding a cap stops supervision and logs why.
3. **Weekly-limit backstop.** After a weekly limit is seen, idle claims suspend
   until the stated weekly reset passes.
4. **Kill switch.** `ckm pause` (this session), `ckm pause --all` (everything).
   Honoured by wrapper and daemon.
5. **Idle claim is opt-in.** It spends quota with no user intent, so it defaults
   to off. Auto-continue of live sessions defaults to on — that continues work the
   user already started.
6. **No credentials.** The tool never reads, stores, or transmits tokens. It reads
   its own state, `~/.claude/sessions/*.json`, and transcripts. Nothing leaves the
   machine.
7. **Auditable.** Every automatic action appends to `ckm.log` before it happens.
8. **Injection is fixed text.** The continuation string is from config, never from
   model output — no path from transcript content to injected keystrokes.

## 6. Data flow

**Wrapped session hits a session limit**

```
user types `claude`  ->  shim  ->  ckm wrap
  spawn real claude in PTY, passthrough both ways
  register {pid, sessionId, cwd, ptyId} in state.json
  watch transcript for error=="rate_limit"
    classify -> SESSION
      parse reset -> absolute Date (authoritative)
      mark session PENDING_RESUME, record boundary in ledger
      sleep until boundary + 20s
      re-check: paused? cap hit? process still alive?
      claim boundary (CAS on lastClaimedBoundary)
      inject configured continuation text + Enter into PTY
      log; increment resume counter
```

**No terminal open**

```
daemon tick (10s)
  read ledger -> next boundary
  boundary passed and unclaimed?
    any live wrapper with pending work?  -> let it claim, do nothing
    idleClaim enabled and caps ok?       -> `claude --bare -p "<ping>"`, claim
    else                                 -> re-arm
```

## 7. Error handling

| Failure | Response |
|---|---|
| Ping fails (network) | Exponential backoff, 3 tries. Then re-derive the boundary from transcripts rather than trusting stored state. |
| Machine slept through a boundary | On wake, recompute from wall clock. Never trust a stored monotonic deadline. |
| Stored boundary disagrees with transcripts | Transcripts win. Re-derive. |
| Wrapped process dies | Deregister, drop pending resume. |
| PID reuse | `procStart` mismatch invalidates the entry. |
| Two daemons | `daemon.lock` with PID + start time; second exits. |
| `node-pty` missing | Degrade to supervise-and-report; never crash. |
| Claude Code output changes | Only `resetparse` and `limits` are format-sensitive, both isolated and fixture-tested. Unparseable → log and stop supervising. Fail safe, never guess. |
| Model limit | Stop supervising, tell the user, exit. |

## 8. Testing

Correctness lives in pure functions, so most tests need no Claude and no clock.

- **ledger** — `floor10` grid, `+5h`, DST, boundary sequences, reset-overrides-computed.
- **resetparse** — every real reset string observed in the corpus, am/pm, midnight/noon, next-day rollover, weekly date form, unparseable input.
- **limits** — SESSION / WEEKLY / MODEL classification against real records; non-limit records must not match.
- **claimer** — resume-vs-ping matrix: paused, capped, weekly-suspended, no pending work, race with an already-claimed boundary.
- **store** — concurrent read-modify-write under lock; corrupt file recovery.
- **sessions** — liveness from fixtures, PID reuse via `procStart`, non-interactive excluded.
- **pty** — wrap a fake `claude` script that prints a limit message on a compressed timescale, assert the continuation is injected exactly once.

Integration test uses a **fake claude binary** fixture, so the whole loop runs in
seconds with no account, no network, no real limits.

## 9. CLI

```
ckm setup                 install shim + background service
ckm status                windows, boundaries, supervised sessions
ckm pause [--all]         disable auto-continue (this session / everything)
ckm resume [--all]        re-enable
ckm claim on|off          toggle idle boundary claiming (default off)
ckm doctor                verify shim, service, node-pty, transcript access
ckm logs [-n]             tail the audit log
ckm config get|set
ckm wrap -- <cmd>         internal: PTY host (what the shim calls)
ckm daemon                internal: background claimer
```

## 10. Distribution

- TypeScript, ESM, Node 18+.
- `npm i -g claudekishmish`, binaries `ckm` and `claudekishmish`.
- Windows, macOS, Linux. `node-pty` optional with graceful degradation.
- MIT, public GitHub repo, CI on all three platforms.

## 11. Non-goals

- Resetting, extending, or bypassing server-side limits. Impossible and not attempted.
- Per-model limits (`/usage-credits`) — detected, then handed back.
- Speaking Claude Code's private daemon IPC.
- Uploading anything anywhere.
