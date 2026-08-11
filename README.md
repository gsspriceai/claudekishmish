# claudekishmish

Keep a Claude Code usage window always running — and continue interrupted work
in the terminal it stopped in.

```bash
npm i -g claudekishmish
ckm setup
```

`ckm setup` prints one thing left to do: put the shim on PATH. **Do it, and open
a new terminal.** Until then only half the tool is running — boundaries are
claimed, but nothing supervises your sessions, so nothing can continue your work.
`ckm status` tells you which half you are in:

```
Install
  shim           installed but NOT on PATH      <-- in-place continuation is OFF
```

On Windows make sure you use the persistent form `ckm setup` prints (it writes
your user environment). The obvious `$env:Path = ...` line lasts until you close
the terminal, which looks identical to working.

Then use `claude` exactly as you always have.

Prefer it illustrated? **[gsspriceai.github.io/claudekishmish](https://gsspriceai.github.io/claudekishmish/)** is the same three steps with the terminal output, the window model drawn out, and every command explained on one page. Source: [`docs/index.html`](docs/index.html).

Windows, macOS and Linux — with one note about macOS below.

[![CI](https://github.com/gsspriceai/claudekishmish/actions/workflows/ci.yml/badge.svg)](https://github.com/gsspriceai/claudekishmish/actions/workflows/ci.yml)

---

## The two problems

**1. Boundaries you never claim.** A Claude Code usage window is five hours long
and starts at your *first message*. It only advances when someone claims it. If a
window expires at 02:00 and you send nothing until 09:00, those seven hours are
dead: no window was running.

**2. Work that stops at 23:40 and waits for you.** A window runs out mid-task.
It reopens at 04:30. You are asleep. The task sits there until you wake up and
type `continue`.

Measured on one real 49-day history: **62 of 71 window boundaries went
unclaimed.**

## What it does

| | |
|---|---|
| **Continues your work** | When the window reopens, the continuation is typed into *your actual terminal session* — same window, same context, work carries on. On by default. |
| **Claims boundaries** | The moment a window expires, a minimal request starts the next countdown. On by default; capped, announced at setup, and every claim is logged. |

## Verified, not assumed

The window model was derived from 90 real `rate_limit` records, then re-checked
against 84,000+ transcript records:

```
windowStart = floor10(first message after the previous window expired)
windowEnd   = windowStart + 5h
```

```
transcripts        : 94 files, 84143 records
limits detected    : 96  {"session":91,"weekly":3,"model":2}
session resets read: 91/91
resets on 10m grid : 91/91
window prediction  : 86/86 exact
```

Every reset time Claude Code has ever stated on that machine landed on a
10-minute grid — `{:00, :10, :20, :30, :40, :50}`, zero exceptions.

### The window is read from history, not remembered

Note the words *first message after the previous window expired*. A message sent
**inside** a window that is already running starts nothing — it rides the window
you already have.

That distinction is the whole ballgame, and getting it wrong is silent. An
earlier version advanced its ledger by its own claims and treated each one as
opening a new window. The first time a claim landed mid-window — because a human
had typed first and started the window twenty minutes earlier — the ledger
described a window that did not exist, and could not recover: every later claim
re-anchored on the last wrong one.

Seen on a real machine on 2026-08-11:

```
truth   07:10 → 12:10     (anchored by the user's own 07:13 message)
ledger  11:50 → 16:50     (anchored by this tool's own claim)
```

`ckm status` reported a healthy window 4h 44m away while the boundary it exists
to catch went by unnoticed.

So the ledger is now re-derived from the conversation history on **every tick**,
and evidence outranks arithmetic:

| Source | Rank | Why |
|---|---|---|
| A reset time the server stated | highest, until it expires | the server is the only party that actually knows |
| Turns in your transcripts | beats anything inferred | a record of what happened |
| Our own claim time | lowest | an assumption about what a claim did |

Two guards keep that from becoming its own bug: history whose window has already
ended is ignored (yesterday's transcript cannot resurrect an expired window), and
a correction that moves the window earlier clears a claimed-boundary marker that
would otherwise sit permanently out of reach.

Re-reading every transcript ten times a minute would be absurd — 885 MB across
94 files on that machine, 1.6 seconds a scan — so files are cached on size and
mtime. Transcripts are append-only, so an unchanged file cannot have gained a
turn, and a warm scan is one `stat` per file.

Check the model against your own history, from a git checkout:

```bash
npm run verify:history
```

That reproduces the four numbers above — limits detected, resets read, grid
alignment, prediction accuracy. It does **not** reproduce the "62 of 71" figure,
which came from a separate one-off analysis of boundary gaps.

## What it cannot do: a sleeping machine

Nothing runs while the machine is suspended, so a boundary that passes at 02:00
with the lid shut is not claimed at 02:00. It is claimed on wake.

Observed on the author's own machine: a boundary at 00:00 was claimed at 06:51,
when the laptop came back. That is a real loss of nearly seven hours of window —
and it is not fixable from user space, because no process exists to send the
request.

What the tool does guarantee is that waking up is handled sanely: it claims
**once**, not once per boundary it slept through, and anchors the new window on
the grid from the moment it actually sent something.

If you want the countdown to survive the night, the machine has to stay awake.

## macOS: what happens about `spawn-helper`

`node-pty` 1.1.0 ships its `spawn-helper` **non-executable** in the darwin
prebuilds, and macOS is the only platform whose code path executes that helper.
On a stock `npm i -g`, allocating a PTY therefore fails with `posix_spawnp
failed` — the module imports perfectly and then every spawn throws, so nothing
that merely checks "is node-pty installed" can see it.

claudekishmish repairs it: on macOS, at load, it adds the missing execute bit
to that one file and leaves every other permission as it found it. Nothing is
patched or replaced — the file is published with that bit and loses it in
transit.

If the repair is refused — a global install under a root-owned prefix — the tool
degrades instead of breaking. Boundary claiming, limit detection and every
command keep working, and your `claude` is unaffected; what you lose is in-place
continuation, the part that types into your terminal. Either reinstall somewhere
you own, or build node-pty from source (needs Xcode command line tools):

```bash
npm_config_build_from_source=true npm i -g claudekishmish
```

`ckm doctor` tells you which mode you are in. It allocates a real PTY rather
than loading the module, because on macOS loading proves nothing.

## When the API stalls rather than refuses

A usage limit is not the only thing that stops work mid-task. The API can be
overloaded, a stream can stall, a socket can drop. Unlike a limit, none of these
state a reset time — the session just stops and waits for a person.

These are continued too, on an exponential backoff (30s, 1m, 2m, 4m, 8m by
default), capped at five attempts. The taxonomy comes from what one real
84,000-line transcript history actually contained:

| Seen | `error` | Status | Treated as |
|---|---|---|---|
| 96 | `rate_limit` | 429 | a limit — it states when it lifts, so it is waited out |
| 33 | `authentication_failed` | — | terminal; the tool halts rather than retrying |
| 4 | `server_error` | — | **retryable** — "Response stalled mid-stream" |
| 4 | `authentication_failed` | 403 | terminal |
| 2 | `unknown` | — | **retryable** — "Unable to connect to API (ConnectionRefused)" |
| 1 | `unknown` | 529 | **retryable** — "API Error: Overloaded" |
| 1 | `oauth_org_not_allowed` | 403 | terminal |

A 4xx is the request's fault and will fail again identically, so it is never
retried. A bare `unknown` is a grab-bag: it is retried only when its text is a
recognised transport failure.

Detection is structural, never textual. Searching those same transcripts for
`API Error: 529` returns conversations *about* error handling — including this
project's own documentation. `isApiErrorMessage` is set by Claude Code on
records it generated itself and cannot be produced by anything a person or a
model wrote in a message.

An outage never consumes a boundary, because the window is still running. A
limit outranks an outage: retrying during a limit cannot succeed, and the limit
knows exactly how long to wait.

An adversarial audit of this feature found two ways it could still loop, both
now fixed and pinned: a limit that had already been acted on was never cleared,
and a stale one made every later outage eligible instantly — backoff and cap
both skipped; and recovery was judged before the poll was absorbed, so a poll
containing both the failure and your own reply armed a continuation anyway.

The attempt count is deliberately an **episode**, not a record. Every failed
continuation writes a new error record, so counting records would reset the
counter each time and turn a cap of five into an unbounded retry loop against an
API that is already failing. The count survives new records and clears only when
your own next message appears.

## Three limits, three responses

Claude Code has three separate caps, and treating them as one is what makes naive
wait-and-retry tools hang for days.

| Limit | What it says | What claudekishmish does |
|---|---|---|
| **Session (5h)** | `hit your session limit · resets 11:30pm` | waits, then continues your work |
| **Weekly** | `hit your weekly limit · resets Aug 6, 10:30pm` | parks it, suspends claiming, tells you |
| **Per-model** | `reached your Fable 5 limit. Run /usage-credits` | stops cleanly and hands back — waiting cannot fix this one |

And if the account itself cannot make requests — logged out, subscription ended,
credentials rejected — the tool **halts** rather than retrying an impossible
request several times a day for ever. `ckm status` says so in the first line, and
`ckm resume --all` clears it once you have fixed it.

## What a boundary claim costs

Measured against a real subscription account:

```
input 2 · cache_read 21,963 · output 13 · ~5.6s
```

At API rates that is roughly **$0.007 on Sonnet, $0.011 on Opus, $0.023 on
Fable** — the tier matters, so take the one you actually run. On a subscription
it costs you window allowance rather than money.

A claim is a real, persisted session — it creates one transcript with one
timestamped turn. That is deliberate: the window a claim opens is only visible
through transcripts, and overnight there is no other session running, so a claim
that persisted nothing would open a window nothing on the machine could see.

The built-in tool schema dominates, and it is read from the prompt cache your
normal sessions already populate. Restricting the tool set was measured too and
is **worse** — it changes the prompt, misses the cache entirely, and costs about
ten times more.

So a claim is cheap, but it is not free, and it counts against your weekly
budget. It is on by default because that is the point of the tool, but it is
never silent: `ckm setup` says so in plain terms, `ckm status` shows the running
count, every claim is logged before it happens, it is capped at 14 a week, and it
suspends itself if you hit a weekly limit. `ckm claim off` stops it outright, and
`ckm setup --no-claim` never starts it.

## Usage

```bash
ckm setup              # install the shim + write the service unit
ckm status             # windows, boundaries, sessions, next action
ckm pause              # stop auto-continuing this session
ckm pause --all        # stop everything (before you go to sleep)
ckm pause --session ID # target one session by id, from anywhere
ckm resume [--all]     # switch it back on; also clears a halt
ckm claim on|off       # boundary claiming when nothing is pending
ckm doctor             # check every dependency, by running them (no billable request)
ckm logs [-n <count>]  # what it did while you were away
ckm config get|set     # settings (maxOutageRetries, outageBackoffMs, ...)
ckm shim               # where the shim is, and how to put it on PATH
ckm uninstall          # remove the shim and the service unit
```

After `ckm setup`, use `claude` exactly as you always have. The shim wraps it.

## How a boundary gets claimed

Two cases, and only two:

| | Situation | What happens |
|---|---|---|
| 1 | A session stopped at the limit | **Continue it.** Continuing *is* claiming — nothing new is created. |
| 2 | Anything else | **Start a fresh session** just to make the claim. |

There is a tempting middle option — typing a word into a terminal that is
already open and idle, which would create nothing and keep the window inside
your own conversation. It is deliberately not done. An idle terminal may still
hold work that matters, and a claim is not worth the risk of putting a stray
exchange in the middle of it.

The continuation in case 1 is fenced regardless: never when a session is paused,
never on a limit that predates this run, never past the resume cap, and **never
when you have something typed but not sent**. We forward every keystroke, so we
know when the input box has a draft in it — appending to a half-written message
and pressing Enter for you is the one way this tool could destroy work instead
of saving it.

## Safety

This tool types into your terminal while you are asleep, so the guarantees matter
more than the features.

1. **Never escalates permissions.** The resumed session keeps exactly the flags
   you launched it with. It never adds `--dangerously-skip-permissions` and never
   widens `--permission-mode`.
2. **Only sessions open in a terminal.** A session qualifies when it is
   `kind: interactive`, `entrypoint: cli`, its PID is alive, and its
   process-start stamp still matches. Checked at registration *and* on every
   liveness poll, so a recycled PID or a background agent can never be mistaken
   for your terminal.
3. **Only limits from this run.** A `rate_limit` record left in a reused
   transcript is history, not a live interruption — acting on one would type
   into a session you have only just opened.
4. **Fixed continuation text.** What gets typed comes from your config, never
   from model output or transcript content. There is no path from something
   Claude wrote to keystrokes in your shell.
5. **A boundary is consumed only by a request that landed.** Actors *reserve* a
   boundary, then convert it to a claim after the request succeeds, and release
   it otherwise — so a failure can never burn a window while reporting a healthy
   one.
6. **Bounded by default.** Three auto-continues per supervised session and
   fourteen idle claims per rolling week, enforced in one place. They are
   defaults, not ceilings — `ckm config set` can raise them — and the per-session
   count lives with the session record, so quitting and reopening starts it
   again.
7. **Real kill switch.** `ckm pause` is re-checked on every tick *and* again in
   the instant before anything is typed.
8. **Nothing leaves your machine.** No credentials are read, stored or
   transmitted. No network calls except Claude Code's own.
9. **An outage retry is bounded twice over.** Five attempts per episode, on a
   capped backoff, and the count is cleared only by your own next message — so a
   failing API is never hammered and a single bad afternoon cannot exhaust the
   budget for the rest of the session.
10. **The ledger can be corrected.** What the tool believes about the current
   window is re-derived from your conversation history every tick, so a wrong
   belief lasts one tick rather than for ever, and a correction is logged
   (`ledger.corrected`) with what it believed and what the evidence said.
11. **Everything is logged** before it happens — `ckm logs`.

## What it is not

- It does **not** reset, extend or bypass server-side limits. That is impossible,
  and nothing here attempts it. It waits for normal availability and then makes
  ordinary requests on your own account.
- It does not spam Claude to force anything.
- It does not speak Claude Code's private daemon IPC.

## How it works

Three roles, one package, coordinating through files — no sockets, no named
pipes, and therefore no per-platform IPC to get wrong.

| Role | Job |
|---|---|
| `ckm wrap` | PTY host. Runs the real `claude` in a pseudo-terminal, passthrough in both directions, types the continuation when the window reopens. |
| `ckm daemon` | Owns the window ledger, reconciling it against transcript history every tick. Claims boundaries when no terminal is open, and **defers** to the wrapper when the pending session belongs to it. |
| `ckm` | status, pause, resume, setup, doctor, logs, uninstall. |

Detection uses the authoritative transcript record, never screen-scraping:

```json
{ "type": "assistant", "error": "rate_limit", "isApiErrorMessage": true,
  "apiErrorStatus": 429,
  "message": { "content": [{ "type": "text",
    "text": "You've hit your session limit · resets 11:30pm (Asia/Calcutta)" }] } }
```

Each tick observes outside the lock, decides inside it, and acts outside it
again — so the shared state lock is never held across transcript I/O, and a
wrapper pumping a live terminal is never blocked.

### `node-pty`

Optional native dependency. If it will not build or load, install still succeeds
and the tool still supervises and claims boundaries — it just reports that
in-place continuation is unavailable. `ckm doctor` tells you which mode you are
in. Note that **Linux has no prebuilt binary**: without python3/make/g++ you will
land in the degraded mode.

## Development

```bash
npm install
npm run build
npm test              # 367 tests
npm run mutation-check   # reintroduce each fixed defect; every one must go red
```

Correctness lives in pure functions (`window/ledger.ts`, `window/claimer.ts`),
tested without Claude, without a PTY and without a real clock. The integration
tests wrap a fake Claude that hits a limit on a compressed timescale, so the full
loop runs in seconds with no account and no network.

The suite is mutation-checked: each fixed defect is reintroduced and the test
written for it must go red. A test that still passes with the bug back in is not
a test. Sixty-four mutations are checked this way, and several were added because
an audit proved the original tests could not see them — most often because a
guard had unit tests and its **call site** had none.

The harness fails on a *skipped* mutation as loudly as on a surviving one. An
anchor that no longer matches the code checks nothing, while still printing a
reassuring line — an untested defect wearing a tested defect's name. Four of them
rotted at once when a Windows checkout converted line endings, which is why
matching is now done against LF whatever is on disk.

## Licence

MIT
