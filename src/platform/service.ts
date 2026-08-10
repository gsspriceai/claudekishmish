/**
 * Background service registration, per platform.
 *
 * The daemon has to survive terminal closure, because the whole point is that it
 * runs while nobody is at the machine.
 *
 * Every command here is **absolute and per-user**:
 *
 *   - launchd passes `ProgramArguments[0]` straight to `posix_spawn` and does no
 *     PATH lookup, so a bare `ckm` fails with ENOENT on every respawn.
 *   - systemd rejects a unit whose `ExecStart` is not an absolute path.
 *   - `schtasks /SC ONLOGON` requires elevation, so Windows uses the per-user
 *     Startup folder instead, which does not.
 *
 * `CKM_HOME` is propagated: without it a daemon started at login reads a
 * different state file than a CLI run from a shell that sets it.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ckmHome } from './paths.js';

export interface ServicePlan {
  kind: 'launchd' | 'systemd' | 'startup-folder' | 'unsupported';
  /** Where the unit or script goes. */
  unitPath?: string;
  unitContents?: string;
  /** The command the user runs to activate it, ready to copy and paste. */
  activate: string[];
  notes: string;
}

const LABEL = 'com.claudekishmish.daemon';

/** Absolute path to this CLI's entry script. */
export function cliEntryPath(): string {
  try {
    // dist/platform/service.js -> dist/cli/index.js
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.resolve(here, '..', 'cli', 'index.js');
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    /* fall through */
  }
  return process.argv[1] ?? 'ckm';
}

/** `node /abs/path/to/cli/index.js daemon`, with node itself absolute too. */
export function daemonCommand(): { node: string; script: string } {
  return { node: process.execPath, script: cliEntryPath() };
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function planService(): ServicePlan {
  const home = os.homedir();
  const { node, script } = daemonCommand();
  const stateDir = ckmHome();

  if (process.platform === 'darwin') {
    const unitPath = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    return {
      kind: 'launchd',
      unitPath,
      unitContents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(script)}</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CKM_HOME</key><string>${xmlEscape(stateDir)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(stateDir, 'daemon.err.log'))}</string>
</dict>
</plist>
`,
      activate: ['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 501}`, unitPath],
      notes: 'Runs at login and restarts if it dies. On macOS 10.x use: launchctl load -w ' + unitPath,
    };
  }

  if (process.platform === 'linux') {
    const unitPath = path.join(home, '.config', 'systemd', 'user', 'claudekishmish.service');
    return {
      kind: 'systemd',
      unitPath,
      unitContents: `[Unit]
Description=claudekishmish usage-window claimer

[Service]
Type=simple
Environment="CKM_HOME=${stateDir}"
ExecStart=${node} ${script} daemon
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`,
      activate: ['systemctl', '--user', 'enable', '--now', 'claudekishmish.service'],
      notes:
        'If systemd does not see it, run `systemctl --user daemon-reload` first. Run `loginctl enable-linger $USER` too, so it keeps running while you are logged out.',
    };
  }

  if (process.platform === 'win32') {
    // The per-user Startup folder needs no elevation, unlike schtasks ONLOGON.
    const startup = path.join(
      process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
    );
    const unitPath = path.join(startup, 'claudekishmish.cmd');
    return {
      kind: 'startup-folder',
      unitPath,
      unitContents:
        '@echo off\r\n' +
        'REM claudekishmish background boundary claimer (per-user, no admin rights)\r\n' +
        `set "CKM_HOME=${stateDir}"\r\n` +
        `start "" /min "${node}" "${script}" daemon\r\n`,
      // Valid PowerShell, which is the shell `ckm setup` names one line
      // earlier. `"<path>" "<path>" daemon` is a parse error there, and running
      // it in the foreground would occupy the terminal and die with it.
      activate: [
        'Start-Process',
        '-WindowStyle',
        'Hidden',
        '-FilePath',
        `"${node}"`,
        '-ArgumentList',
        `"${script}","daemon"`,
      ],
      notes:
        'Installed to your Startup folder, so it begins at every login. The command above also starts it right now, detached from this terminal.',
    };
  }

  return { kind: 'unsupported', activate: [], notes: 'Run `ckm daemon` yourself.' };
}

/** Write the unit file. Activation stays a separate, explicit user action. */
export function writeServiceUnit(): ServicePlan {
  const plan = planService();
  if (plan.unitPath && plan.unitContents) {
    fs.mkdirSync(path.dirname(plan.unitPath), { recursive: true });
    fs.writeFileSync(plan.unitPath, plan.unitContents, 'utf8');
  }
  return plan;
}

export function removeServiceUnit(): string | null {
  const plan = planService();
  if (!plan.unitPath) return null;
  try {
    fs.unlinkSync(plan.unitPath);
    return plan.unitPath;
  } catch {
    return null;
  }
}
