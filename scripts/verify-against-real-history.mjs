/**
 * Run the shipped detector and window model over this machine's real Claude Code
 * history and report how well they hold up.
 *
 * Fixtures test the shape you expected. This tests the shape that is actually on
 * disk, which is the only one that matters.
 *
 *   node scripts/verify-against-real-history.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dist = (p) => 'file:///' + path.resolve('dist', p).replace(/\\/g, '/');
const { toLimitEvent } = await import(dist('claude/limits.js'));
const { computeWindow, WINDOW_MS } = await import(dist('window/ledger.js'));

const projects = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
  : path.join(os.homedir(), '.claude', 'projects');

if (!fs.existsSync(projects)) {
  console.log(`no transcripts at ${projects} — nothing to verify`);
  process.exit(0);
}

const files = [];
for (const project of fs.readdirSync(projects)) {
  const dir = path.join(projects, project);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
  }
}

const limits = [];
const userTurns = [];
let lines = 0;

for (const file of files) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    lines++;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'user' && rec.timestamp) {
      const t = Date.parse(rec.timestamp);
      if (Number.isFinite(t)) userTurns.push(t);
    }
    const event = toLimitEvent(rec, new Date());
    if (event) limits.push(event);
  }
}

userTurns.sort((a, b) => a - b);

const byKind = limits.reduce((acc, e) => ((acc[e.kind] = (acc[e.kind] ?? 0) + 1), acc), {});
const sessionLimits = limits.filter((e) => e.kind === 'session');
const parsed = sessionLimits.filter((e) => e.resetAt !== null);
const onGrid = parsed.filter((e) => new Date(e.resetAt).getMinutes() % 10 === 0);

console.log(`transcripts        : ${files.length} files, ${lines} records`);
console.log(`user turns         : ${userTurns.length}`);
console.log(`limits detected    : ${limits.length}  ${JSON.stringify(byKind)}`);
console.log(`session resets read: ${parsed.length}/${sessionLimits.length}`);
console.log(`resets on 10m grid : ${onGrid.length}/${parsed.length}`);

// Does windowStart = floor10(first turn) predict the reset the server stated?
let checked = 0;
let matched = 0;
for (const event of parsed) {
  const impliedStart = event.resetAt - WINDOW_MS;
  // The anchoring turn is the first one at or after the implied window start.
  const anchor = userTurns.find((t) => t >= impliedStart && t < event.resetAt);
  if (anchor === undefined) continue;
  // Only judge cases where the anchor is plausibly the window's first message.
  if (anchor - impliedStart > 10 * 60_000) continue;
  checked++;
  if (computeWindow(anchor).end === event.resetAt) matched++;
}

console.log(`window prediction  : ${matched}/${checked} exact`);
console.log(
  matched === checked && checked > 0
    ? 'MODEL HOLDS on real history.'
    : checked === 0
      ? 'not enough overlapping data to judge the model here'
      : 'MODEL DISAGREES with real history — investigate before trusting the ledger',
);
