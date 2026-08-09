/**
 * A stand-in for Claude Code, used by the integration test.
 *
 * It reproduces the three behaviours the supervisor actually depends on:
 *   1. writes a session descriptor to <CLAUDE_CONFIG_DIR>/sessions/<pid>.json
 *   2. writes a transcript containing a real-shaped `rate_limit` record
 *   3. stays alive on a PTY and reacts to text typed into it
 *
 * When it receives the continuation it writes a marker file, which is what the
 * test asserts on. Nothing here talks to the network or to a real account.
 */

import fs from 'node:fs';
import path from 'node:path';

const configDir = process.env.CLAUDE_CONFIG_DIR;
const sessionId = process.env.FAKE_SESSION_ID ?? '11111111-2222-3333-4444-555555555555';
const marker = process.env.FAKE_MARKER;
const resetText = process.env.FAKE_RESET_TEXT ?? "You've hit your session limit · resets 11:30pm (Asia/Calcutta)";

// 1. Session descriptor, in exactly the shape Claude Code writes.
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
    kind: 'interactive',
    entrypoint: 'cli',
    name: 'fake-session',
    nameSource: 'derived',
    status: 'busy',
    updatedAt: Date.now(),
  }),
);

// 2. Transcript with the authoritative rate-limit envelope.
const projectDir = path.join(configDir, 'projects', 'fake-project');
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(
  path.join(projectDir, `${sessionId}.jsonl`),
  JSON.stringify({
    type: 'assistant',
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    timestamp: new Date().toISOString(),
    sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text: resetText }] },
  }) + '\n',
);

process.stdout.write('fake-claude ready\n');

// 3. React to typed input the way a TUI would.
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  if (buffer.includes('continue')) {
    fs.writeFileSync(marker, JSON.stringify({ receivedAt: Date.now(), buffer }));
    process.stdout.write('CONTINUED\n');
  }
});

// Stay alive so the PTY stays open; the test kills us.
setInterval(() => {}, 1000);
