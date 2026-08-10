/**
 * Mutation check.
 *
 * Reintroduce each defect an audit found, one at a time, and confirm the test
 * written for it actually goes red. A test that still passes with the bug back
 * in is not a test — and several here were added precisely because a first pass
 * proved the original tests could not see the bug.
 *
 * Every entry restores the file afterwards, and the build is restored at the
 * end. Run it with a clean working tree.
 *
 *     npm run mutation-check
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run from the repo root.
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

const MUTATIONS = [
  {
    name: 'P0-2  daemon consumes a boundary it cannot act on',
    file: 'src/window/claimer.ts',
    find: `      if (!graceOver) {
        return {
          action: 'defer',`,
    replace: `      if (false) {
        return {
          action: 'defer',`,
    expect: 'test/supervisor.test.ts',
  },
  {
    name: 'P1-8  a failed attempt still burns the boundary',
    file: 'src/supervisor/index.ts',
    find: `        ledger = releaseReservation(ledger, ctx.actor.id);`,
    replace: `        ledger = commitClaim(ledger, ctx.actor.id, Date.now()).ledger;`,
    expect: 'test/supervisor.test.ts',
  },
  {
    name: 'P1-3  a stale limit from an earlier run is acted on',
    file: 'src/window/claimer.ts',
    find: `  if (session.limit.detectedAt < session.supervisedFrom) {`,
    replace: `  if (false) {`,
    expect: 'test/claimer.test.ts',
  },
  {
    name: 'P1-5  the state lock does nothing',
    file: 'src/state/store.ts',
    find: `      const handle = await fsp.open(stateLockPath(), 'wx');`,
    replace: `      const handle = await fsp.open(stateLockPath(), 'w');`,
    expect: 'test/store.test.ts',
  },
  {
    name: 'P1-4  a non-interactive session is supervised',
    file: 'src/claude/sessions.ts',
    find: `  return s.kind === 'interactive' && s.entrypoint === 'cli';`,
    replace: `  return true;`,
    expect: 'test/sessions.test.ts',
  },
  {
    name: 'P0-3  ckm wrap never exits',
    file: 'src/cli/index.ts',
    find: `  process.exit(code);`,
    replace: `  process.exitCode = code;`,
    expect: 'test/integration.test.ts',
  },
  {
    name: 'P1-9  the ledger freezes on the first reset message',
    file: 'src/window/ledger.ts',
    find: `    ledger.source === 'reset-message' && ledger.currentEnd !== null && now < ledger.currentEnd;`,
    replace: `    ledger.source === 'reset-message';`,
    expect: 'test/ledger.test.ts',
  },
  {
    name: 'P0-1  ping uses --bare and cannot authenticate',
    file: 'src/window/ping.ts',
    find: `    '--strict-mcp-config',`,
    replace: `    '--bare',`,
    expect: 'test/ping.test.ts',
  },
  {
    name: 'ping does not persist a session (invisible overnight)',
    file: 'src/window/ping.ts',
    find: `    '--disable-slash-commands',`,
    replace: `    '--disable-slash-commands',\n    '--no-session-persistence',`,
    expect: 'test/overnight.test.ts test/ping.test.ts',
  },
  {
    name: 'injects over the user\'s unsent draft',
    file: 'src/pty/inject.ts',
    find: `  if (session.hasDraftInput()) {`,
    replace: `  if (false) {`,
    expect: 'test/inject.test.ts',
  },
  {
    name: 'commit without holding the reservation (freezes the ledger)',
    file: 'src/window/ledger.ts',
    find: `  if (!holdsReservation(ledger, owner, claimedAt)) {`,
    replace: `  if (false) {`,
    expect: 'test/ledger.test.ts',
  },
  {
    name: 'an impossible ledger is never repaired',
    file: 'src/window/ledger.ts',
    find: `    ledger.lastClaimedBoundary >= ledger.currentEnd`,
    replace: `    false`,
    expect: 'test/ledger.test.ts',
  },
  {
    name: 'reservation expires before the act phase can finish',
    file: 'src/window/ledger.ts',
    find: `export const RESERVATION_TTL_MS = 10 * MINUTE_MS;`,
    replace: `export const RESERVATION_TTL_MS = 1 * MINUTE_MS;`,
    expect: 'test/ledger.test.ts',
  },
  {
    name: 'the draft guard is unwired from the keystroke stream',
    file: 'src/pty/host.ts',
    find: `      draft.observe(text);`,
    replace: ``,
    expect: 'test/draft.test.ts',
  },
  {
    name: 'Alt+Enter counts as a submit (submits a half-written message)',
    file: 'src/pty/host.ts',
    find: `          if (prev === ESC || prev === '\\\\' || looksPasted) {`,
    replace: `          if (false) {`,
    expect: 'test/draft.test.ts',
  },
  {
    name: 'the descriptor wait ignores a child that already exited (hangs the shell)',
    file: 'src/cli/commands/wrap.ts',
    find: `    if (hasExited()) return null;`,
    replace: ``,
    expect: 'test/integration.test.ts',
  },
  {
    name: 'a limit hit by the claim itself is ignored (retries for ever)',
    file: 'src/supervisor/index.ts',
    find: `      next = absorbLimit(next, null, result.limit, Date.now());`,
    replace: ``,
    expect: 'test/overnight.test.ts',
  },
  {
    name: 'a bare 401 halts the tool permanently',
    file: 'src/claude/failure.ts',
    find: '  /authentication_error/i,',
    replace: '  /authentication_error/i,\n  /\\b401\\b/,',
    expect: 'test/failure.test.ts',
  },
  {
    name: 'a per-model cap is read as an ended subscription (permanent halt)',
    file: 'src/claude/failure.ts',
    find: 'const MODEL_CAP_PATTERNS: RegExp[] = [',
    replace: 'const MODEL_CAP_PATTERNS: RegExp[] = []; const UNUSED: RegExp[] = [',
    expect: 'test/failure.test.ts',
  },
  {
    name: 'no halt ever clears itself',
    file: 'src/claude/failure.ts',
    find: `  return reason === 'model' ? now + MODEL_CAP_BACKOFF_MS : null;`,
    replace: `  void now; return null;`,
    expect: 'test/failure.test.ts test/claimer.test.ts',
  },
  {
    name: 'a session the user rescued is continued anyway, hours later',
    file: 'src/supervisor/index.ts',
    find: `      next = absorbUserRecovery(next, obs.sessionId, obs.turns);`,
    replace: ``,
    expect: 'test/supervisor.test.ts',
  },
  {
    name: 'an I/O error is read as "no state" and wipes everything',
    file: 'src/state/store.ts',
    find: `    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(Date.now());
    throw err;`,
    replace: `    void err;
    return emptyState(Date.now());`,
    expect: 'test/store.test.ts',
  },
  {
    name: 'a corrupt state file is discarded without a trace',
    file: 'src/state/store.ts',
    find: `    quarantineCorruptState();`,
    replace: ``,
    expect: 'test/store.test.ts',
  },
  {
    name: 'Enter is pressed even if the user typed during the settle pause',
    file: 'src/pty/inject.ts',
    find: `  if (session.hasDraftInput()) {
    logWarn('inject.aborted_mid_write', { pid: session.pid });`,
    replace: `  if (false) {
    logWarn('inject.aborted_mid_write', { pid: session.pid });`,
    expect: 'test/inject.test.ts',
  },
  {
    name: 'a resume is gated on a boundary, stranding a second session',
    file: 'src/window/claimer.ts',
    find: `  const boundaryDue = isBoundaryDue(state.ledger, now, config.boundaryBufferMs);`,
    replace: `  const boundaryDue = isBoundaryDue(state.ledger, now, config.boundaryBufferMs);
  if (!boundaryDue) return { action: 'none', reason: 'boundary not due' };`,
    expect: 'test/claimer.test.ts',
  },
  {
    name: 'M2  a terminal failure never halts',
    file: 'src/supervisor/index.ts',
    find: `      next.halted = {`,
    replace: `      next.halted = 0 && {`,
    expect: 'test/wiring.test.ts',
  },
  {
    name: 'M3  stillEligible always says yes',
    file: 'src/supervisor/index.ts',
    find: `  if (state.globalPaused || state.halted) return false;`,
    replace: `  if (false) return false;`,
    expect: 'test/wiring.test.ts',
  },
  {
    name: 'M4  one unreadable poll unsupervises a live session',
    file: 'src/supervisor/index.ts',
    find: `const MAX_MISSED_LIVENESS = 5;`,
    replace: `const MAX_MISSED_LIVENESS = 1;`,
    expect: 'test/wiring.test.ts',
  },
  {
    name: 'M5  the pid-reuse guard is unwired at the call site',
    file: 'src/supervisor/index.ts',
    find: `      ? checkSessionLiveness(id, session.procStart, session.pid)`,
    replace: `      ? checkSessionLiveness(id, null, null)`,
    expect: 'test/wiring.test.ts',
  },
  {
    name: 'M8  the claim runs in the home directory and discovers a project',
    file: 'src/window/ping.ts',
    find: `        cwd: os.tmpdir(),`,
    replace: `        cwd: os.homedir(),`,
    expect: 'test/wiring.test.ts',
  },
  {
    name: 'the macOS spawn-helper repair is never called (job 2 dead on macOS)',
    file: 'src/pty/host.ts',
    find: `    repair();`,
    replace: ``,
    expect: 'test/spawn-helper.test.ts',
  },
  {
    name: 'the repair chmods on every platform, not just macOS',
    file: 'src/pty/spawn-helper.ts',
    find: `  if (platform !== 'darwin') return 'not-darwin';

  const helper = findSpawnHelper(entry);`,
    replace: `  const helper = findSpawnHelper(entry);`,
    expect: 'test/spawn-helper.test.ts',
  },
  {
    name: 'the repair widens permissions instead of adding one bit',
    file: 'src/pty/spawn-helper.ts',
    find: `    ops.chmod(helper, (mode | EXEC_BITS) & 0o7777);`,
    replace: `    ops.chmod(helper, 0o777);`,
    expect: 'test/spawn-helper.test.ts',
  },
  {
    name: 'the helper search climbs out of the package',
    file: 'src/pty/spawn-helper.ts',
    find: `  for (let i = 0; i < 5; i++) {`,
    replace: `  for (let i = 0; i < 500; i++) {`,
    expect: 'test/spawn-helper.test.ts',
  },
  {
    name: 'doctor reports a broken pty everywhere except this repo',
    file: 'src/cli/commands/doctor.ts',
    find: '    `const pty = require(${JSON.stringify(entry)});`,',
    replace: `    "const pty = require('node-pty');",`,
    expect: 'test/doctor.test.ts',
  },
  {
    name: 'a 24-hour reset string is unparseable (continuation never fires)',
    file: 'src/claude/resetparse.ts',
    find: `  if (!m) return parse24HourReset(text, now);`,
    replace: `  if (!m) return null;`,
    expect: 'test/resetparse.test.ts',
  },
];

let survived = 0;
let skipped = 0;
for (const m of MUTATIONS) {
  const original = fs.readFileSync(m.file, 'utf8');
  if (!original.includes(m.find)) {
    // A skip is a failure, not a note. An anchor rots the moment the code it
    // points at is reformatted, and a silently-skipped mutation is an untested
    // defect wearing a tested defect's name — the exact failure this script
    // exists to catch, occurring inside the script itself.
    console.log(`SKIP  ${m.name}\n      (anchor not found in ${m.file})`);
    skipped++;
    continue;
  }
  fs.writeFileSync(m.file, original.replace(m.find, m.replace), 'utf8');

  let red = false;
  try {
    execSync('npm run build', { stdio: 'pipe' });
    execSync(`npx vitest run ${m.expect}`, { stdio: 'pipe' });
  } catch {
    red = true;
  } finally {
    fs.writeFileSync(m.file, original, 'utf8');
  }

  console.log(`${red ? 'CAUGHT' : 'SURVIVED'}  ${m.name}  ->  ${m.expect}`);
  if (!red) survived++;
}

execSync('npm run build', { stdio: 'pipe' });

const problems = [];
if (survived > 0) problems.push(`${survived} SURVIVED — those tests prove nothing`);
if (skipped > 0) problems.push(`${skipped} SKIPPED — those anchors have rotted and check nothing`);

console.log('');
if (problems.length === 0) {
  console.log(`All ${MUTATIONS.length} mutations caught.`);
} else {
  console.log(problems.join('\n'));
  process.exitCode = 1;
}
