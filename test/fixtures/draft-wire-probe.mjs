/**
 * Exercises the real `spawnPty` keystroke path and prints what the draft
 * tracker saw, as JSON.
 *
 * It runs as its own process because ConPTY cannot attach a console inside a
 * vitest worker — the same reason the integration tests drive `ckm wrap` as a
 * child rather than calling it in-process.
 *
 * The result goes to a file, not stdout: the PTY forwards the child's own
 * output to this process's stdout, which would corrupt the JSON.
 *
 *   node draft-wire-probe.mjs <scenario> <dist-host-url> <result-file>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

const [scenario, hostUrl, resultFile] = process.argv.slice(2);
const { spawnPty, loadNodePty } = await import(hostUrl);

const ESC = '\u001b';
const CR = '\r';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!(await loadNodePty())) {
  fs.writeFileSync(resultFile, JSON.stringify({ skipped: 'node-pty unavailable' }));
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-wire-'));
const result = {};

try {
  if (scenario === 'utf8') {
    // A child that records exactly what reached its stdin.
    const seen = path.join(dir, 'seen.txt');
    const child = path.join(dir, 'echo.mjs');
    fs.writeFileSync(
      child,
      [
        `import fs from 'node:fs';`,
        `let buf = '';`,
        `process.stdin.setEncoding('utf8');`,
        `process.stdin.on('data', (c) => { buf += c; fs.writeFileSync(${JSON.stringify(seen)}, buf); });`,
        `process.stdin.resume(); setInterval(() => {}, 1000);`,
      ].join('\n'),
    );

    const input = new PassThrough();
    const session = await spawnPty(process.execPath, [child], dir, {}, input);
    await wait(400);

    // Split a 4-byte emoji down the middle. A naive per-chunk toString() would
    // forward replacement characters and corrupt the user's own keystrokes.
    const bytes = Buffer.from('cafe 🐈');
    input.write(bytes.subarray(0, bytes.length - 2));
    await wait(150);
    input.write(bytes.subarray(bytes.length - 2));
    await wait(400);

    result.seen = fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8') : '';
    session.kill();
  } else {
    const child = path.join(dir, 'stay-alive.mjs');
    fs.writeFileSync(child, 'process.stdin.resume(); setInterval(() => {}, 1000);');

    const input = new PassThrough();
    const session = await spawnPty(process.execPath, [child], dir, {}, input);
    await wait(400);

    result.atStart = session.hasDraftInput();

    if (scenario === 'typing') {
      input.write(Buffer.from('refactor the parser'));
      await wait(250);
      result.afterTyping = session.hasDraftInput();
      input.write(Buffer.from(CR));
      await wait(250);
      result.afterEnter = session.hasDraftInput();
    } else if (scenario === 'altenter') {
      input.write(Buffer.from(`multi line start${ESC}${CR}`));
      await wait(250);
      result.afterAltEnter = session.hasDraftInput();
    }
    session.kill();
  }
  fs.writeFileSync(resultFile, JSON.stringify(result));
} finally {
  await wait(200);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the pty may still hold it briefly; the OS temp dir will be cleaned up */
  }
}
process.exit(0);
