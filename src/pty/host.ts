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

import { StringDecoder } from 'node:string_decoder';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { toLaunchable } from '../claude/spawn.js';
import { logWarn } from '../logger/index.js';

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
   * We forward every keystroke, so we can tell. Injecting over a draft would
   * append our text to theirs and press Enter, submitting a half-written
   * message — the one way this tool could destroy work rather than save it.
   */
  hasDraftInput(): boolean;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

const ESC = '\u001b';
const CR = '\r';
const LF = '\n';
const CTRL_C = '\u0003';
const CTRL_U = '\u0015';
const BACKSPACE = '\u007f';
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/**
 * Track whether the user has an unsubmitted line in the input box.
 *
 * The governing rule: **a false "clean" submits the user's half-written
 * message; a false "dirty" only costs one deferred continuation, retried on the
 * next tick.** So clearing is deliberately hard and staying dirty is easy.
 *
 * The first version cleared on any CR, LF or ESC, which reported CLEAN for both
 * documented ways to put a newline in Claude Code's input box — Alt/Option+Enter
 * (ESC then CR) and a trailing backslash then Enter. Someone typing a multi-line
 * message and stepping away would have had it submitted for them hours later.
 *
 * Only three things clear the box now: Enter that is not continuing a line,
 * Ctrl-C, and Ctrl-U. A bare ESC does not, because it is indistinguishable from
 * the start of an escape sequence; and a chunk carrying a newline plus more
 * content does not, because composing is far likelier than submitting.
 */
export function draftTracker() {
  let dirty = false;
  /** Last character seen, kept across chunks so ESC+CR split over two reads works. */
  let prev = '';
  let inBracketedPaste = false;

  return {
    /** Feed every keystroke the user sends, decoded but otherwise untouched. */
    observe(input: string): void {
      let text = input;

      // Bracketed paste is unambiguous: everything inside the markers is content.
      for (;;) {
        if (!inBracketedPaste) {
          const start = text.indexOf(PASTE_START);
          if (start === -1) break;
          inBracketedPaste = true;
          dirty = true;
          text = text.slice(start + PASTE_START.length);
          continue;
        }
        const end = text.indexOf(PASTE_END);
        if (end === -1) break;
        inBracketedPaste = false;
        dirty = true;
        text = text.slice(end + PASTE_END.length);
      }
      if (inBracketedPaste) {
        if (text.length > 0) dirty = true;
        return;
      }

      // A chunk carrying a newline alongside other content is a paste, not a
      // keypress. Treat every newline in it as part of the draft.
      const newlines = (text.match(/[\r\n]/g) ?? []).length;
      const looksPasted =
        newlines > 1 || (newlines === 1 && text.length > 2 && !/[\r\n]$/.test(text));

      for (const ch of text) {
        if (ch === CR || ch === LF) {
          if (prev === ESC || prev === '\\' || looksPasted) {
            // A newline *inside* the box: Alt+Enter, backslash-continuation, or
            // pasted content. Still unsent, and now multi-line.
            dirty = true;
          } else {
            dirty = false;
          }
        } else if (ch === CTRL_C || ch === CTRL_U) {
          dirty = false;
        } else if (ch === BACKSPACE || ch === '\b') {
          // A backspace may have emptied the box, but we cannot know. Staying
          // dirty is the cheap error.
        } else if (ch >= ' ') {
          dirty = true;
        }
        prev = ch;
      }
    },
    isDirty: () => dirty,
    /** Our own injected text must not be mistaken for the user's typing. */
    reset(): void {
      dirty = false;
      prev = '';
      inBracketedPaste = false;
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
 * and mode change is undone on exit, so the caller's process can terminate.
 */
export async function spawnPty(
  bin: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
  /**
   * The keystroke source. Defaults to this process's stdin; injectable so a
   * test can drive the *real* wiring, which is otherwise untestable — deleting
   * the tracker's feed used to leave the whole suite green.
   */
  input: NodeJS.ReadableStream & {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?: (raw: boolean) => void;
  } = process.stdin,
  /**
   * Allocate a pseudo-terminal at all.
   *
   * A PTY makes the child believe it is on a terminal, which is right for an
   * interactive session and wrong for `claude -p "..." > file`: that pipeline
   * would receive screen-clearing and cursor sequences instead of plain text.
   * When false, stdio is inherited and the child sees exactly what it would
   * have seen unsupervised.
   */
  usePty = true,
  /**
   * The node-pty module to use. Injectable so a test can drive the failure this
   * guards against — a module that loads and then throws on `spawn`, which is
   * exactly what macOS does and what no test could reach otherwise.
   */
  ptyModule?: NodePtyModule | null,
): Promise<PtySession> {
  const pty = usePty ? (ptyModule !== undefined ? ptyModule : await loadNodePty()) : null;
  const env = childEnv(extraEnv);

  // Loading node-pty is not the same as being able to use it.
  //
  // On macOS the module loads fine and `spawn` throws `posix_spawnp failed`,
  // because node-pty ships its `spawn-helper` non-executable in the darwin
  // prebuilds and only the macOS code path execs that helper. Unguarded, the
  // throw escaped a top-level await and killed the process — so installing this
  // tool made every interactive `claude` on macOS die with a stack trace, while
  // `ckm doctor` reported node-pty as available.
  //
  // Any PTY allocation failure — a sandbox, fd exhaustion, a future regression —
  // now degrades to the inherited-stdio path instead of taking the user's
  // `claude` down with it.
  let proc: NodePtyProcess | null = null;
  if (pty) {
    try {
      proc = pty.spawn(bin, args, {
        name: process.env.TERM ?? 'xterm-256color',
        cols: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 30,
        cwd,
        env,
      });
    } catch (err) {
      logWarn('pty.spawn_failed', {
        message: (err as Error).message,
        note: 'falling back to inherited stdio; in-place continuation is unavailable',
      });
      proc = null;
    }
  }

  if (proc) {
    const term = proc;

    const dataHandlers: ((chunk: string) => void)[] = [];
    const exitHandlers: ((code: number) => void)[] = [];
    /**
     * The child can exit before the caller has registered a handler — a
     * `claude --version` is gone in well under a second. Latch the code so a
     * late registration still fires, rather than the exit being delivered to
     * nobody and the caller waiting for ever.
     */
    let exitedWith: number | null = null;

    term.onData((chunk) => {
      process.stdout.write(chunk);
      for (const h of dataHandlers) h(chunk);
    });

    const draft = draftTracker();
    // A decoder, not `buf.toString()`: a multi-byte character split across two
    // reads would otherwise be forwarded as replacement characters and the
    // user's own keystrokes would be corrupted in their session.
    const decoder = new StringDecoder('utf8');
    const onStdin = (buf: Buffer) => {
      const text = decoder.write(buf);
      if (text.length === 0) return;
      draft.observe(text);
      term.write(text);
    };

    const wasRaw = input.isTTY ? Boolean(input.isRaw) : false;
    if (input.isTTY) input.setRawMode?.(true);
    input.resume();
    input.on('data', onStdin);

    const onResize = () => term.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 30);
    process.stdout.on('resize', onResize);

    term.onExit(({ exitCode }) => {
      input.off('data', onStdin);
      process.stdout.off('resize', onResize);
      if (input.isTTY) input.setRawMode?.(wasRaw);
      input.pause();
      exitedWith = exitCode;
      for (const h of exitHandlers) h(exitCode);
    });

    return {
      pid: term.pid,
      canInject: true,
      hasDraftInput: () => draft.isDirty(),
      write: (data: string) => {
        term.write(data);
        // Our own text is not the user's typing; do not let it look like a draft.
        draft.reset();
        return true;
      },
      onData: (cb) => dataHandlers.push(cb),
      onExit: (cb) => {
        if (exitedWith !== null) cb(exitedWith);
        else exitHandlers.push(cb);
      },
      resize: (cols, rows) => term.resize(cols, rows),
      kill: () => term.kill(),
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
  let exitedWith: number | null = null;
  const settle = (code: number) => {
    if (exitedWith !== null) return;
    exitedWith = code;
    for (const h of exitHandlers) h(code);
  };
  child.on('exit', (code) => settle(code ?? 0));
  child.on('error', () => settle(127));

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
    onExit: (cb) => {
      if (exitedWith !== null) cb(exitedWith);
      else exitHandlers.push(cb);
    },
    resize: () => {},
    kill: () => child.kill(),
  };
}
