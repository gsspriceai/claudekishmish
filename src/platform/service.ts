/**
 * Background service registration, per platform.
 *
 * The daemon has to survive terminal closure, because the whole point is that it
 * runs while nobody is at the machine. Rather than shipping a bespoke service
 * manager we write the native unit for each OS and let the OS supervise it.
 *
 * Nothing here runs a privileged command: all three targets are per-user.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ServicePlan {
  kind: 'launchd' | 'systemd' | 'schtasks' | 'unsupported';
  /** Where the unit file goes, if there is one. */
  unitPath?: string;
  unitContents?: string;
  /** The command the user runs to activate it. */
  activate: string[];
  notes: string;
}

const LABEL = 'com.claudekishmish.daemon';

function ckmBin(): string {
  // Prefer the globally-installed launcher; fall back to this very script.
  return process.platform === 'win32' ? 'ckm.cmd' : 'ckm';
}

export function planService(): ServicePlan {
  const home = os.homedir();

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
  <array><string>${ckmBin()}</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${path.join(home, '.claudekishmish', 'daemon.err.log')}</string>
</dict>
</plist>
`,
      activate: ['launchctl', 'load', '-w', unitPath],
      notes: 'Runs at login and restarts if it dies.',
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
ExecStart=${ckmBin()} daemon
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`,
      activate: ['systemctl', '--user', 'enable', '--now', 'claudekishmish.service'],
      notes: 'Enable lingering (loginctl enable-linger $USER) to run while logged out.',
    };
  }

  if (process.platform === 'win32') {
    return {
      kind: 'schtasks',
      activate: [
        'schtasks',
        '/Create',
        '/TN',
        'claudekishmish',
        '/TR',
        // schtasks takes the whole command as one argument, and it contains a
        // space — unquoted, Windows parses "daemon" as a schtasks flag.
        `"${ckmBin()} daemon"`,
        '/SC',
        'ONLOGON',
        '/F',
      ],
      notes: 'Registers a per-user logon task. No admin rights required.',
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
