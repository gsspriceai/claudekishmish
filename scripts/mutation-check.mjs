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
    find: `  if (limit.detectedAt < session.supervisedFrom) {`,
    replace: `  if (false) {`,
    expect: 'test/claimer.test.ts',
  },
  {
    name: 'P1-5  the state lock does nothing',
    file: 'src/state/store.ts',
    find: `const openLockExclusive: LockOpener = () => fsp.open(stateLockPath(), 'wx');`,
    replace: `const openLockExclusive: LockOpener = () => fsp.open(stateLockPath(), 'w');`,
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

  // The platform`,
    replace: `  // The platform`,
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
    name: 'the helper search misses prebuilt installs (the macOS layout)',
    file: 'src/pty/spawn-helper.ts',
    find: "  const dirs = ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`];",
    replace: "  const dirs = ['build/Release'];",
    expect: 'test/spawn-helper.test.ts',
  },
  {
    name: 'the repair looks for darwin paths using the host platform',
    file: 'src/pty/spawn-helper.ts',
    find: '  const helper = findSpawnHelper(entry, platform);',
    replace: '  const helper = findSpawnHelper(entry);',
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
    name: 'a newline in the configured continuation submits half a message',
    file: 'src/config/index.ts',
    find: "  out.continuationText = singleLine(out.continuationText, MAX_CONTINUATION, DEFAULT_CONFIG.continuationText);",
    replace: "  if (out.continuationText.trim() === '') out.continuationText = DEFAULT_CONFIG.continuationText;",
    expect: 'test/config.test.ts',
  },
  {
    name: 'the config accepts a continuation the injector will refuse to type',
    file: 'src/pty/inject.ts',
    find: 'export const MAX_CONTINUATION_LENGTH = 500;',
    replace: 'export const MAX_CONTINUATION_LENGTH = 2000;',
    expect: 'test/config.test.ts test/inject.test.ts',
  },
  {
    name: 'the ledger is never reconciled against history (the 2026-08-11 bug)',
    file: 'src/supervisor/index.ts',
    find: '      next = { ...next, ledger: reconciled.ledger };',
    replace: '',
    expect: 'test/wiring.test.ts',
  },
  {
    name: 'reconciliation refuses to move the window EARLIER',
    file: 'src/window/reconcile.ts',
    find: '  if (derived.end <= now) return unchanged;',
    replace:
      '  if (derived.end <= now) return unchanged;' +
      ' if (ledger.currentEnd !== null && derived.end <= ledger.currentEnd) return unchanged;',
    expect: 'test/reconcile.test.ts',
  },
  {
    name: 'stale history resurrects an expired window',
    file: 'src/window/reconcile.ts',
    find: '  if (derived.end <= now) return unchanged;',
    replace: '',
    expect: 'test/reconcile.test.ts',
  },
  {
    name: 'a corrected window keeps a claim it can never reach again',
    file: 'src/window/reconcile.ts',
    find: '    ledger.lastClaimedBoundary !== null && ledger.lastClaimedBoundary >= derived.end',
    replace: '    false',
    expect: 'test/reconcile.test.ts',
  },
  {
    name: 'inference overrules a live server-stated reset',
    file: 'src/window/reconcile.ts',
    find: "  if (ledger.source === 'reset-message' && ledger.currentEnd !== null && now < ledger.currentEnd) {",
    replace: '  if (false) {',
    expect: 'test/reconcile.test.ts',
  },
  {
    name: 'the turn cache never notices a file changed (window stops advancing)',
    file: 'src/claude/turn-cache.ts',
    find: '    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {',
    replace: '    if (hit) {',
    expect: 'test/turn-cache.test.ts',
  },
  {
    name: 'the turn cache holds on to deleted transcripts',
    file: 'src/claude/turn-cache.ts',
    find: '    if (!seen.has(known)) cache.delete(known);',
    replace: '',
    expect: 'test/turn-cache.test.ts',
  },
  {
    name: 'Windows delete-pending on the lock is fatal instead of contention',
    file: 'src/state/store.ts',
    find: "  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES';",
    replace: "  return code === 'EEXIST';",
    expect: 'test/store.test.ts',
  },
  {
    name: 'the lock retry ignores the contention rule entirely',
    file: 'src/state/store.ts',
    find: '      if (!isLockContention(code)) throw err;',
    replace: "      if (code !== 'EEXIST') throw err;",
    expect: 'test/store.test.ts',
  },
  {
    name: 'every outage record resets the attempt count (unbounded retry loop)',
    file: 'src/supervisor/index.ts',
    find: '  const attempts = sameEpisode ? existing.attempts : 0;',
    replace: '  const attempts = 0;',
    expect: 'test/outage-backoff.test.ts',
  },
  {
    name: 'an outage from an older build crashes every tick after upgrade',
    file: 'src/supervisor/index.ts',
    find: '  const existing = session.outage ?? null;',
    replace: '  const existing = session.outage;',
    expect: 'test/outage-backoff.test.ts',
  },
  {
    name: 'the outage retry cap does nothing',
    file: 'src/window/claimer.ts',
    find: '  if (outage.attempts >= config.maxOutageRetries) {',
    replace: '  if (false) {',
    expect: 'test/outage-backoff.test.ts',
  },
  {
    name: 'the outage backoff is ignored (retries instantly, in a loop)',
    file: 'src/window/claimer.ts',
    find: '  if (now < outage.retryAt) {',
    replace: '  if (false) {',
    expect: 'test/outage-backoff.test.ts',
  },
  {
    name: 'an outage from an earlier run of the session is acted on',
    file: 'src/window/claimer.ts',
    find: '  if (outage.detectedAt < session.supervisedFrom) {',
    replace: '  if (false) {',
    expect: 'test/outage-backoff.test.ts',
  },
  {
    name: 'authentication failures are retried as outages',
    file: 'src/claude/outage.ts',
    find: '  if (TERMINAL_ERRORS.has(error)) return null;',
    replace: '',
    expect: 'test/outage.test.ts',
  },
  {
    name: 'prose about API errors is treated as an API error',
    file: 'src/claude/outage.ts',
    find: '  if (record.isApiErrorMessage !== true) return null;',
    replace: '',
    expect: 'test/outage.test.ts',
  },
  {
    name: 'the outage backoff grows without a cap',
    file: 'src/claude/outage.ts',
    find: '  return from + Math.min(grown, capMs);',
    replace: '  return from + grown;',
    expect: 'test/outage.test.ts',
  },
  {
    name: 'outages are never read from the transcript at all',
    file: 'src/supervisor/index.ts',
    find: '        next = absorbOutage(next, obs.sessionId, obs.outage, ctx.config, now);',
    replace: '',
    expect: 'test/wiring.test.ts',
  },
  {
    name: 'ckm status hides an outage entirely',
    file: 'src/cli/commands/status.ts',
    find: '    if (s.outage) {',
    replace: '    if (false) {',
    expect: 'test/status.test.ts',
  },
  {
    name: 'the outage attempt counter never increases (retry loop at tick rate)',
    file: 'src/supervisor/index.ts',
    find: '                    attempts: session.outage.attempts + 1,',
    replace: '                    attempts: session.outage.attempts,',
    expect: 'test/wiring.test.ts',
  },
  {
    name: 'a spent limit shadows a live outage (audit P0-2)',
    file: 'src/window/claimer.ts',
    find: '  if (outage && limitHasPassed(limit, config, now) && outage.detectedAt >= limit.detectedAt) {',
    replace: '  if (false) {',
    expect: 'test/outage-backoff.test.ts',
  },
  {
    name: 'a limit is never cleared once acted on (audit P0-2)',
    file: 'src/supervisor/index.ts',
    find: '            limit: ok ? null : session.limit,',
    replace: '',
    expect: 'test/wiring.test.ts',
  },
  {
    name: 'recovery is judged before the batch is absorbed (audit P0-1/P1-1)',
    file: 'src/supervisor/index.ts',
    find: '      next = absorbUserRecovery(next, obs.sessionId, obs.turns);',
    replace: '',
    expect: 'test/wiring.test.ts test/supervisor.test.ts',
  },
  {
    name: 'an outage that work continued past still arms a continuation',
    file: 'src/claude/transcript.ts',
    find: '    if (record.isApiErrorMessage !== true) return null;',
    replace: '',
    expect: 'test/outage.test.ts',
  },
  {
    name: 'an out-of-order record resets the outage episode',
    file: 'src/supervisor/index.ts',
    find: '  if (existing && event.detectedAt < existing.detectedAt) return state;',
    replace: '',
    expect: 'test/outage-backoff.test.ts',
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
  const onDisk = fs.readFileSync(m.file, 'utf8');

  // Match against LF regardless of what is on disk.
  //
  // Git converts line endings on checkout, so on a Windows working copy every
  // multi-line anchor here fails to match a file that is byte-for-byte correct.
  // Four of them rotted at once that way — and a rotted anchor is an untested
  // defect wearing a tested defect's name, which is the failure this script
  // exists to catch. The file is restored in its original form either way.
  const crlf = onDisk.includes('\r\n');
  const original = crlf ? onDisk.replace(/\r\n/g, '\n') : onDisk;
  const toDisk = (text) => (crlf ? text.replace(/\n/g, '\r\n') : text);

  if (!original.includes(m.find)) {
    // A skip is a failure, not a note. An anchor rots the moment the code it
    // points at is reformatted, and a silently-skipped mutation is an untested
    // defect wearing a tested defect's name — the exact failure this script
    // exists to catch, occurring inside the script itself.
    console.log(`SKIP  ${m.name}\n      (anchor not found in ${m.file})`);
    skipped++;
    continue;
  }
  fs.writeFileSync(m.file, toDisk(original.replace(m.find, m.replace)), 'utf8');

  let red = false;
  try {
    execSync('npm run build', { stdio: 'pipe' });
    execSync(`npx vitest run ${m.expect}`, { stdio: 'pipe' });
  } catch {
    red = true;
  } finally {
    fs.writeFileSync(m.file, onDisk, 'utf8');
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
