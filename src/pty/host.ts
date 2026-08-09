/**
 * PTY host: run the real `claude` inside a pseudo-terminal we own.
 *
 * Owning the PTY is the only way to continue a session *in the terminal it was
 * interrupted in*. Every supported alternative (`-r`, `-c`, `--fork-session`,
 * `--teleport`, `claude agents`) starts a new process, and Claude Code's own
 * daemon IPC is undocumented and version-fragile.
 *
 * `node-pty` is a native module and an optional dependency. When it is missing
 * we still run, still supervise, and still claim boundaries — we just say
 * plainly that in-place continuation is unavailable. Install never hard-fails
 * over it.
 */

import { spawn as spawnChild, type ChildProcess } from 'node:child_process';

export interface PtySession {
  /** PID of the spawned `claude`. */
  pid: number;
  /** Type text into the session. Returns false when injection is unsupported. */
  write(data: string): boolean;
  /** Can this host inject input? False in the degraded, no-node-pty path. */
  readonly canInject: boolean;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): NodePtyProcess;
}

interface NodePtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
}

/** Load node-pty if it is installed and loadable on this platform. */
export async function loadNodePty(): Promise<NodePtyModule | null> {
  try {
    const mod = (await import('node-pty')) as unknown as NodePtyModule & { default?: NodePtyModule };
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

function stringEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  // Lets a nested `claude` know it is already under supervision.
  out.CKM_SUPERVISED = '1';
  return out;
}

/**
 * Spawn `claude` under a PTY, wired transparently to this terminal.
 *
 * The parent's stdin is switched to raw mode so the child sees keystrokes
 * exactly as it would if it had been launched directly — arrow keys, Ctrl-C,
 * bracketed paste and the TUI's own redraws all behave normally.
 */
export async function spawnPty(
  bin: string,
  args: string[],
  cwd: string,
): Promise<PtySession> {
  const pty = await loadNodePty();

  if (pty) {
    const proc = pty.spawn(bin, args, {
      name: process.env.TERM ?? 'xterm-256color',
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 30,
      cwd,
      env: stringEnv(),
    });

    const dataHandlers: ((chunk: string) => void)[] = [];
    const exitHandlers: ((code: number) => void)[] = [];

    proc.onData((chunk) => {
      process.stdout.write(chunk);
      for (const h of dataHandlers) h(chunk);
    });

    const onStdin = (buf: Buffer) => proc.write(buf.toString('utf8'));
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onStdin);

    const onResize = () => proc.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 30);
    process.stdout.on('resize', onResize);

    proc.onExit(({ exitCode }) => {
      process.stdin.off('data', onStdin);
      process.stdout.off('resize', onResize);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      for (const h of exitHandlers) h(exitCode);
    });

    return {
      pid: proc.pid,
      canInject: true,
      write: (data: string) => {
        proc.write(data);
        return true;
      },
      onData: (cb) => dataHandlers.push(cb),
      onExit: (cb) => exitHandlers.push(cb),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: () => proc.kill(),
    };
  }

  // Degraded path: inherit stdio directly. The session behaves exactly as normal
  // and we still supervise it through the transcript, but we cannot type into it.
  const child: ChildProcess = spawnChild(bin, args, {
    cwd,
    stdio: 'inherit',
    env: stringEnv(),
  });

  const exitHandlers: ((code: number) => void)[] = [];
  child.on('exit', (code) => {
    for (const h of exitHandlers) h(code ?? 0);
  });

  return {
    pid: child.pid ?? -1,
    canInject: false,
    write: () => false,
    onData: () => {
      /* no PTY to observe in the degraded path */
    },
    onExit: (cb) => exitHandlers.push(cb),
    resize: () => {},
    kill: () => child.kill(),
  };
}
