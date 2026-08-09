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
| **Claims boundaries** | The moment a window expires, a minimal request starts the next countdown, so the clock never stops. Opt-in. |
| **Continues your work** | When the window reopens, the continuation is typed into *your actual terminal session* — same window, same context, work carries on. |

You wake up to the session you left, further along.

## Verified, not assumed

The window model was derived from 90 real `rate_limit` records, then checked
against 76,167 transcript records:

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
node scripts/verify-against-real-history.mjs
```

## Three limits, three responses

Claude Code has three separate caps, and treating them as one is what makes naive
wait-and-retry tools hang for days.

| Limit | What it says | What claudekishmish does |
|---|---|---|
| **Session (5h)** | `hit your session limit · resets 11:30pm` | waits, then continues your work |
| **Weekly** | `hit your weekly limit · resets Aug 6, 10:30pm` | parks it, suspends claiming, tells you |
| **Per-model** | `reached your Fable 5 limit. Run /usage-credits` | stops cleanly and hands back — waiting cannot fix this one |

## Usage

```bash
ckm setup              # install the shim + write the service unit
ckm status             # windows, boundaries, sessions, next action
ckm pause              # stop auto-continuing this session
ckm pause --all        # stop everything (before you go to sleep)
ckm resume [--all]     # switch it back on
ckm claim on|off       # boundary claiming when nothing is pending
ckm doctor             # check every dependency
ckm logs               # what it did while you were away
```

After `ckm setup`, use `claude` exactly as you always have. The shim wraps it.

### `ckm status`

```
claudekishmish

  Window
    current ends   Aug 09, 07:30 PM   (reset-message)
    next boundary  Aug 09, 07:30 PM   in 2h 14m
    last claimed   Aug 09, 02:30 PM

  Supervised sessions (1)
    zlash-backend-26  (98399394)  pending-resume
      cwd     E:\ZLASH BACKEND
      resumes 0/3
      limit   session — resets Aug 09, 07:30 PM

  Policy
    auto-continue  on
    idle claiming  off   (0/14 used this week)
    global pause   active

  Next action    none — boundary not due
```

## Safety

This tool types into your terminal while you are asleep, so the guarantees matter
more than the features.

1. **Never escalates permissions.** The resumed session keeps exactly the flags
   you launched it with. It never adds `--dangerously-skip-permissions` and never
   widens `--permission-mode`.
2. **Only sessions open in a terminal.** A session qualifies when it is
   `kind: interactive`, its PID is alive, and its process-start stamp still
   matches — so a recycled PID can never be mistaken for your session.
3. **Fixed continuation text.** What gets typed comes from your config, never
   from model output or transcript content. There is no path from something
   Claude wrote to keystrokes in your shell.
4. **Hard caps.** Three auto-continues per session, fourteen idle claims per
   week. Exceeding one stops supervision and says why.
5. **Weekly backstop.** After a weekly cap is seen, claiming suspends until it
   actually resets. The tool will not eat the budget it exists to protect.
6. **Real kill switch.** `ckm pause` is re-checked on every tick *and* again in
   the instant before anything is typed.
7. **Nothing leaves your machine.** No credentials are read, stored or
   transmitted. No network calls except Claude Code's own.
8. **Everything is logged** before it happens — `ckm logs`.

**Idle claiming is off by default.** It spends quota with no task behind it, so
it should be a deliberate choice: `ckm claim on`.

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
| `ckm daemon` | Owns the window ledger. Claims boundaries when no terminal is open. |
| `ckm` | status, pause, resume, setup, doctor, logs. |

Detection uses the authoritative transcript record, never screen-scraping:

```json
{ "type": "assistant", "error": "rate_limit", "isApiErrorMessage": true,
  "apiErrorStatus": 429,
  "message": { "content": [{ "type": "text",
    "text": "You've hit your session limit · resets 11:30pm (Asia/Calcutta)" }] } }
```

A boundary is claimed **exactly once**: continuing pending work *is* the claim,
and a ping is only sent when there is nothing to continue.

### `node-pty`

Optional native dependency. If it will not build or load, install still succeeds
and the tool still supervises and claims boundaries — it just reports that
in-place continuation is unavailable. `ckm doctor` tells you which mode you are
in.

## Development

```bash
npm install
npm run build
npm test          # 106 tests
```

Correctness lives in pure functions (`window/ledger.ts`, `window/claimer.ts`),
tested without Claude, without a PTY and without a real clock. The integration
test wraps a fake Claude that hits a limit on a compressed timescale, so the full
loop runs in seconds with no account and no network.

## Licence

MIT
