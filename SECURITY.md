# Security

claudekishmish installs a `claude` shim on your PATH, runs a background daemon,
and **types into a live terminal session**. That is a lot of trust for a small
tool, so the properties it relies on are written down and enforced in one place
each.

## What it will not do

- **Never escalates permissions.** A continued session keeps exactly the flags it
  was launched with. Nothing adds `--dangerously-skip-permissions` or widens
  `--permission-mode`.
- **Only ever types fixed text.** The continuation comes from your config, never
  from model output or transcript content. There is no path from something Claude
  wrote to keystrokes in your shell. `isSafeContinuation` rejects control
  characters, escape sequences and anything over 500 characters.
- **Never types over an unsent draft.** Every keystroke is observed, so a
  half-written message in the input box blocks the continuation — checked when
  deciding, and again in the instant before Enter.
- **Only sessions open in a terminal.** `kind: interactive`, `entrypoint: cli`, a
  live PID, and a matching process-start stamp, so a recycled PID or a background
  agent can never be mistaken for your session.
- **Nothing leaves your machine.** There is no network code in the published
  package — no `fetch`, no `http`, no sockets. The only requests made are Claude
  Code's own, on your account.

## Reporting a vulnerability

Please report privately rather than opening a public issue:

- GitHub Security Advisories:
  https://github.com/gsspriceai/claudekishmish/security/advisories/new

Include what you did, what happened, and your OS and shell. Anything that makes
the tool type text it should not, act on a session it does not own, or escape the
bounds above is in scope — as is any way to make it spend usage a user did not
ask for.

Expect an acknowledgement within a few days. This is a solo project, so please
allow reasonable time before disclosing publicly.

## Turning it off in a hurry

```bash
ckm pause --all     # stop all continuation and claiming, immediately
ckm uninstall       # remove the shim and the autostart entry
```

Both are honoured on the next tick and re-checked immediately before anything is
typed.
