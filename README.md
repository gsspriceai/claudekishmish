# claudekishmish

Keep a Claude Code usage window always running — and continue interrupted work
in the terminal it stopped in.

```bash
npm i -g claudekishmish
ckm setup
```

Windows, macOS and Linux.

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
| **Claims boundaries** | The moment a window expires, a minimal request starts the next countdown, so the clock never stops. On by default; capped, announced at setup, and every claim is logged. |

## Verified, not assumed

The window model was derived from 90 real `rate_limit` records, then checked
against 76,000+ transcript records:

```
windowStart = floor10(first message after the previous window expired)
windowEnd   = windowStart + 5h
```

```
limits detected    : 90  {"session":85,"weekly":3,"model":2}
session resets read: 85/85
resets on 10m grid : 85/85
window prediction  : 80/80 exact
```

Every reset time Claude Code has ever stated on that machine landed on a
10-minute grid — `{:00, :10, :20, :30, :40, :50}`, zero exceptions. Reproduce it
on your own history:

```bash
npm run verify:history        # or: node scripts/verify-against-real-history.mjs
```

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
input 2 · cache_read 21,963 · output 13 · ~5.6s      (~$0.023 at API rates)
```

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
ckm resume [--all]     # switch it back on; also clears a halt
ckm claim on|off       # boundary claiming when nothing is pending
ckm doctor             # check every dependency, and actually run claude
ckm logs [-n]          # what it did while you were away
ckm config get|set     # settings
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
6. **Hard caps.** Three auto-continues per session, fourteen idle claims per
   week, both enforced in one place.
7. **Real kill switch.** `ckm pause` is re-checked on every tick *and* again in
   the instant before anything is typed.
8. **Nothing leaves your machine.** No credentials are read, stored or
   transmitted. No network calls except Claude Code's own.
9. **Everything is logged** before it happens — `ckm logs`.

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
| `ckm daemon` | Owns the window ledger. Claims boundaries when no terminal is open, and **defers** to the wrapper when the pending session belongs to it. |
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
npm test          # 179 tests
```

Correctness lives in pure functions (`window/ledger.ts`, `window/claimer.ts`),
tested without Claude, without a PTY and without a real clock. The integration
tests wrap a fake Claude that hits a limit on a compressed timescale, so the full
loop runs in seconds with no account and no network.

The suite is mutation-checked: each fixed defect is reintroduced and the test
written for it must go red. A test that still passes with the bug back in is not
a test.

## Licence

MIT
