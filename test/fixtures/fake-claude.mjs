/**
 * A stand-in for Claude Code, used by the integration tests.
 *
 * It reproduces the behaviours the supervisor actually depends on:
 *   1. writes a session descriptor to <CLAUDE_CONFIG_DIR>/sessions/<pid>.json
 *   2. writes a transcript containing a real-shaped `rate_limit` record
 *   3. stays alive on a PTY and reacts to text typed into it
 *   4. exits on request, so the wrapper's own exit can be asserted
 *
 * The limit record is written *after* a delay by default, because a record that
 * predates supervision is deliberately ignored — `FAKE_STALE_LIMIT=1` writes one
 * up front to exercise exactly that.
 */

import fs from 'node:fs';
import path from 'node:path';

const configDir = process.env.CLAUDE_CONFIG_DIR;
const sessionId = process.env.FAKE_SESSION_ID ?? '11111111-2222-3333-4444-555555555555';
const marker = process.env.FAKE_MARKER;
const kind = process.env.FAKE_KIND ?? 'interactive';
const entrypoint = process.env.FAKE_ENTRYPOINT ?? 'cli';
const limitDelayMs = Number(process.env.FAKE_LIMIT_DELAY_MS ?? '1200');
const staleLimit = process.env.FAKE_STALE_LIMIT === '1';
const resetText =
  process.env.FAKE_RESET_TEXT ?? "You've hit your session limit · resets 11:30pm (Asia/Calcutta)";

const sessionsDir = path.join(configDir, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
fs.writeFileSync(
  path.join(sessionsDir, `${process.pid}.json`),
  JSON.stringify({
    pid: process.pid,
    sessionId,
    cwd: process.cwd(),
    startedAt: Date.now(),
    procStart: 'fake-proc-start',
    version: '2.1.226',
    peerProtocol: 1,
    kind,
    entrypoint,
    name: 'fake-session',
    nameSource: 'derived',
    status: 'busy',
    updatedAt: Date.now(),
  }),
);

const projectDir = path.join(configDir, 'projects', 'fake-project');
fs.mkdirSync(projectDir, { recursive: true });
const transcript = path.join(projectDir, `${sessionId}.jsonl`);
fs.writeFileSync(transcript, '');

/** The authoritative rate-limit envelope, exactly as Claude Code writes it. */
function writeLimit(timestamp) {
  fs.appendFileSync(
    transcript,
    JSON.stringify({
      type: 'assistant',
      error: 'rate_limit',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      timestamp,
      sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: resetText }] },
    }) + '\n',
  );
}

if (staleLimit) {
  // 26 hours old: history from an earlier run of this same session id.
  writeLimit(new Date(Date.now() - 26 * 3600_000).toISOString());
} else {
  setTimeout(() => writeLimit(new Date().toISOString()), limitDelayMs);
}

process.stdout.write('fake-claude ready\n');

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  if (buffer.includes('continue')) {
    fs.writeFileSync(marker, JSON.stringify({ receivedAt: Date.now(), buffer }));
    process.stdout.write('CONTINUED\n');
    buffer = '';
  }
  if (buffer.includes('quit')) {
    process.exit(7);
  }
});

// Stay alive so the PTY stays open until the test says otherwise.
setInterval(() => {}, 1000);
