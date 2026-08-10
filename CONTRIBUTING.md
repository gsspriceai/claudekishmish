# Contributing

Two things trip up a first change, and neither is discoverable:

**1. Build before you test.** Several tests drive the compiled CLI as a child
process, so `dist/` has to exist and be current:

```bash
npm install
npm run build
npm test          # runs the build for you; `npx vitest run` does not
```

**2. A defect fix is expected to come with a mutation.** Add an entry to
`scripts/mutation-check.mjs` that reintroduces the bug you fixed, then run:

```bash
npm run mutation-check
```

It reintroduces each known defect one at a time and fails if the test written for
it still passes. Several entries exist because an audit proved the original tests
could not see the bug they were named after — usually because a guard had unit
tests and its **call site** had none. A skipped mutation fails the run too: an
anchor rots as soon as the code it points at is reformatted.

## What the tests are for

- `window/ledger.ts` and `window/claimer.ts` are pure functions of
  `(state, now)`. Everything correctness-critical lives there and is testable
  without Claude, without a PTY, and without a real clock.
- `test/wiring.test.ts` exercises **call sites** through `tick` and the real
  store, not helpers in isolation.
- The integration tests wrap a fake Claude on a compressed timescale, so the
  whole loop runs in seconds with no account and no network.

**Never let a test invoke a real `claude` binary.** It spends the user's usage
allowance. Stub `CKM_CLAUDE_BIN`, and point `CKM_HOME` and `CLAUDE_CONFIG_DIR` at
temp directories so nothing touches real state.

## Style

Match the surrounding code. Comments explain *why*, especially where a decision
looks wrong until you know what it prevents — most of them record a defect that
actually happened.
