/**
 * A stand-in for `claude -p`, used by the overnight-claim test.
 *
 * It records the arguments it was handed and writes a session transcript with
 * one timestamped user turn — which is exactly what a real claim does, and what
 * the window ledger later reads back.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const configDir = process.env.CLAUDE_CONFIG_DIR;
const argsFile = process.env.FAKE_ARGS_FILE;
/** Set to make the claim itself fail with a given message, as Claude Code would. */
const failWith = process.env.FAKE_FAIL_TEXT;

// Record how we were invoked, so the test can assert on the real flag set.
if (argsFile) {
  fs.writeFileSync(argsFile, JSON.stringify(process.argv.slice(2)), 'utf8');
}

if (failWith) {
  // Claude Code prints this to stdout, not stderr.
  process.stdout.write(failWith + '\n');
  process.exit(1);
}

// A real claim creates a real session. Reproduce that.
const sessionId = randomUUID();
const projectDir = path.join(configDir, 'projects', 'C--tmp-claim');
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(
  path.join(projectDir, `${sessionId}.jsonl`),
  [
    JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      sessionId,
      message: { role: 'user', content: [{ type: 'text', text: 'ok' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hey!' }] },
    }),
  ].join('\n') + '\n',
);

process.stdout.write('Hey! What are you working on today?\n');
process.exit(0);
