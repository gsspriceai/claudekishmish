/**
 * PTY host: run the real `claude` inside a pseudo-terminal we own.
 *
 * Owning the PTY is the only way to continue a session *in the terminal it was
 * interrupted in*. Every supported alternative (`-r`, `-c`, `--fork-session`,
 * `--teleport`, `claude agents`) starts a new process, and Claude Code's own
 * daemon IPC is undocumented and version-fragile.
 *
 * `node-pty` is a native module and an optional dependency. It is loaded
 * through a non-literal specifier so that TypeScript never tries to resolve it
 * at build time — otherwise `npm ci --omit=optional` cannot compile the project
 * at all. When it is missing we still run, still supervise, and still claim
 * boundaries; we just say plainly that in-place continuation is unavailable.
 */

import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { toLaunchable } from '../claude/spawn.js';

export interface PtySession {
  /** PID of the spawned `claude`. */
  pid: number;
  /** Type text into the session. Returns false when injection is unsupported. */
  write(data: string): boolean;
  /** Can this host inject input? False in the degraded, no-node-pty path. */
  readonly canInject: boolean;
  /**
   * Has the user typed something they have not submitted?
   *
   * We forward every keystroke, so we can tell: anything typed since the last
   * Enter is an unsubmitted draft. Injecting then would append our text to
   * theirs and press Enter, submitting a half-written message — which is the
   * one way this tool could actively damage someone's work.
   */
  hasDraftInput(): boolean;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/**
 * Track whether the user has an unsubmitted line in the input box.
 *
 * Deliberately conservative: anything that is not clearly a submit or a clear
 * leaves the draft flag set, because a false "no draft" is the expensive
 * mistake — it submits the user's half-written message — while a false "has
 * draft" only costs us one deferred continuation.
 */
export function draftTracker() {
  let dirty = false;
  return {
    /** Feed every byte the user types. */
    observe(input: string): void {
      for (const ch of input) {
        if (ch === '\r' || ch === '\n') {
          dirty = false; // submitted
        } else if (ch === '\u0003' || ch === '\u001b') {
          dirty = false; // Ctrl-C or Escape clears the box
        } else if (ch === '\u007f' || ch === '\b') {
          // A backspace might have emptied the box, but we cannot know; stay
          // dirty rather than guess in the dangerous direction.
        } else if (ch >= ' ') {
          dirty = true;
        }
      }
    },
    isDirty: () => dirty,
    /** Our own injected text must not be mistaken for the user's typing. */
    reset(): void {
      dirty = false;
    },
  };
}

interface NodePtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
}

interface NodePtyModule {
  spawn(file: string, args: string[], options: Record<string, unknown>): NodePtyProcess;
}

/** Load node-pty if it is installed and loadable on this platform. */
export async function loadNodePty(): Promise<NodePtyModule | null> {
  // Non-literal on purpose: keeps the optional dependency out of type resolution.
  const specifier = 'node-pty';
  try {
    const mod = (await import(specifier)) as { default?: NodePtyModule } & NodePtyModule;
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

function childEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return { ...out, ...extra };
}

/**
 * Spawn `claude` under a PTY, wired transparently to this terminal.
 *
 * The parent's stdin is switched to raw mode so the child sees keystrokes
 * exactly as it would if it had been launched directly — arrow keys, Ctrl-C,
 * bracketed paste and the TUI's own redraws all behave normally. Every listener
 * and mode change is undone on exit, so the caller's process can actually
 * terminate afterwards.
 */
export async function spawnPty(
  bin: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<PtySession> {
  const pty = await loadNodePty();
  const env = childEnv(extraEnv);

  if (pty) {
    const proc = pty.spawn(bin, args, {
      name: process.env.TERM ?? 'xterm-256color',
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 30,
      cwd,
      env,
      useConpty: process.platform === 'win32' ? undefined : false,
    });

    const dataHandlers: ((chunk: string) => void)[] = [];
    const exitHandlers: ((code: number) => void)[] = [];

    proc.onData((chunk) => {
      process.stdout.write(chunk);
      for (const h of dataHandlers) h(chunk);
    });

    const draft = draftTracker();
    const onStdin = (buf: Buffer) => {
      const text = buf.toString('utf8');
      draft.observe(text);
      proc.write(text);
    };
    const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onStdin);

    const onResize = () => proc.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 30);
    process.stdout.on('resize', onResize);

    proc.onExit(({ exitCode }) => {
      process.stdin.off('data', onStdin);
      process.stdout.off('resize', onResize);
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      for (const h of exitHandlers) h(exitCode);
    });

    return {
      pid: proc.pid,
      canInject: true,
      hasDraftInput: () => draft.isDirty(),
      write: (data: string) => {
        proc.write(data);
        // Our own text is not the user's typing; do not let it look like a draft.
        draft.reset();
        return true;
      },
      onData: (cb) => dataHandlers.push(cb),
      onExit: (cb) => exitHandlers.push(cb),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: () => proc.kill(),
    };
  }

  // Degraded path: inherit stdio directly. The session behaves exactly as normal
  // and we still supervise it through the transcript, but we cannot type into
  // it. `toLaunchable` keeps a Windows batch shim from failing with EINVAL.
  const { file, prefixArgs } = toLaunchable(bin);
  const child: ChildProcess = spawnChild(file, [...prefixArgs, ...args], {
    cwd,
    stdio: 'inherit',
    env,
  });

  const exitHandlers: ((code: number) => void)[] = [];
  child.on('exit', (code) => {
    for (const h of exitHandlers) h(code ?? 0);
  });
  child.on('error', () => {
    for (const h of exitHandlers) h(127);
  });

  return {
    pid: child.pid ?? -1,
    canInject: false,
    // We do not own the input stream here, so we cannot know. Say "draft" and
    // stay out of the way.
    hasDraftInput: () => true,
    write: () => false,
    onData: () => {
      /* no PTY to observe in the degraded path */
    },
    onExit: (cb) => exitHandlers.push(cb),
    resize: () => {},
    kill: () => child.kill(),
  };
}
