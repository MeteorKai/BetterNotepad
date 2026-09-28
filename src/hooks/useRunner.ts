import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "../i18n";

export interface InterpreterConfig {
  language: string;
  command: string;
  args: string[];
  enabled: boolean;
  available: boolean;
}

export interface RunLine {
  id: string;
  stream: "stdout" | "stderr";
  line: string;
  /** Purely informational notice from the app itself (cwd, hints). */
  notice?: boolean;
  /**
   * Identity for the renderer, assigned once as the line enters the transcript.
   *
   * The list is re-rendered on every batch and trimmed from the front once it
   * hits its cap, so an index-based key would make every row below the cut look
   * new to the memoised row component — the trim would cost a full re-render,
   * exactly when the list is at its longest. A key that survives the shift is
   * what keeps the per-batch cost proportional to the lines that arrived.
   */
  seq?: number;
}

export interface RunExit {
  id: string;
  code: number | null;
  /**
   * Where this run's complete output was written, if anywhere. The panel is
   * capped and the terminal's scrollback is capped; this file is not, so it is
   * what makes the early output of a chatty script reachable again.
   */
  log: RunLogInfo | null;
}

/** The file a finished run's output was written to. */
export interface RunLogInfo {
  path: string;
  lines: number;
  bytes: number;
}

/** An interactive shell this machine can start, as reported by the backend. */
export interface ShellInfo {
  /** Stable id, also what the user's preference is stored as. */
  id: string;
  command: string;
  args: string[];
  available: boolean;
}

/**
 * The interactive shell that lives beside the run output.
 *
 * It is a full PTY session of its own rather than a mode of the run terminal:
 * the run terminal's session is torn down and rebuilt on every run (see the
 * `closeTerminal()` call in `run`), which is exactly the wrong lifetime for a
 * shell — a `pip install` must survive the user running a script meanwhile.
 */
export interface ShellSession {
  /** Backend session id, so a stale channel message can be ignored. */
  id: string;
  /** Which shell is on screen (`powershell`, `cmd`, …). */
  kind: string;
  /** False once the process has exited; its output stays on screen. */
  running: boolean;
  /** Where the shell's complete output went, once the backend reports it. */
  log: RunLogInfo | null;
}

/**
 * One message from the PTY backend. `data` is a raw terminal byte stream —
 * escape sequences, carriage returns and all — which is what makes progress
 * bars and colours work; `exit` carries the final status instead.
 */
interface PtyChunk {
  kind: "data" | "exit";
  data: number[];
  code: number | null;
  /** Present on the `exit` chunk only. */
  log?: RunLogInfo | null;
}

/**
 * Payload of the batched `run://output` event. The backend coalesces output, so
 * one message carries every line printed since the previous flush — the
 * frontend just appends them all in one go.
 */
interface RunOutputBatch {
  id: string;
  lines: { stream: "stdout" | "stderr"; line: string }[];
}

type PendingOutput =
  | { kind: "line"; value: RunLine }
  | { kind: "stream"; values: string[] };

/** Byte stream and lifecycle control for the terminal renderer. */
export interface TerminalSink {
  write: (data: Uint8Array) => void;
  clear: () => void;
  focus: () => void;
  refit: () => void;
}

const CONFIG_KEY = "betternotepad.interpreters";
const OUT_EVENT = "run://output";
const EXIT_EVENT = "run://exit";

/** Fallback geometry; the real value arrives from the fit addon on mount. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const OUTPUT_BATCH_MS = 50;

/**
 * Upper bound on the plain-text transcript.
 *
 * Every batch re-renders the whole list (there is no virtualisation), so an
 * unbounded array makes each update cost more than the last one and a
 * long-running program slowly grinds the window to a halt. This is therefore a
 * rendering budget, not a decision about how much output is worth keeping: the
 * backend writes every run's complete output to a log file, and the panel
 * offers that file the moment the run ends. Being trimmed here costs the user
 * nothing but a click.
 *
 * Kept in step with the terminal renderer's scrollback so switching between the
 * two views does not change how much history survives.
 */
export const MAX_OUTPUT_LINES = 20000;

/**
 * How long to wait before typing a queued command line into a shell again, and
 * how many times to try before giving up on it.
 *
 * A command line asked for at the same moment as the session is ready to be
 * typed into, but opening a session is not instant: `pty_open` sets the
 * console's code page through a throwaway process *before* the real shell is
 * spawned, and only registers the session after that. A write that lands in
 * that window is rejected by the backend, so the line has to be kept and tried
 * again rather than dropped — dropping it is what made the first Run after
 * opening a terminal do nothing and the second one work.
 */
const INJECT_DELAY_MS = 700;
const INJECT_MAX_TRIES = 8;

/**
 * Whether `kind` obeys POSIX shell rules.
 *
 * All three of the non-Windows presets do — see `SHELL_PRESETS` in the backend —
 * so this is a set rather than a comparison against bash. Getting it wrong is
 * silent: zsh would be handed cmd's quoting and `cd /d`, which is not a `cd` at
 * all but an attempt to enter a directory named `/d`.
 */
function isPosix(kind: string): boolean {
  return kind === "bash" || kind === "zsh" || kind === "sh";
}

/**
 * Quote one token for the shell that will receive it.
 *
 * Each shell has its own idea of what a quote means, and this has to be right or
 * the run silently does nothing at all: a path with a space, or a folder named
 * in Chinese, is the ordinary case rather than the exotic one.
 */
function quoteToken(token: string, kind: string): string {
  if (isPosix(kind)) {
    // Single quotes are literal in POSIX shells, and the one character they
    // cannot contain is the quote itself: closing, splicing in an escaped quote
    // and reopening is the standard way around that.
    return `'${token.replace(/'/g, `'\\''`)}'`;
  }
  // PowerShell expands variables, subexpressions and backticks in double quotes.
  // Single quotes are literal; double an apostrophe to keep it inside the token.
  if (kind === "powershell") return `'${token.replace(/'/g, "''")}'`;
  // cmd reads `""` inside a quoted token as one literal quote.
  return `"${token.replace(/"/g, '""')}"`;
}

/** How `kind` moves itself into a directory. */
function cdCommand(dir: string, kind: string): string {
  if (kind === "powershell") return `Set-Location -LiteralPath ${quoteToken(dir, kind)}`;
  if (isPosix(kind)) return `cd ${quoteToken(dir, kind)}`;
  // `/d`, because without it `cd` refuses to leave the current drive.
  return `cd /d ${quoteToken(dir, kind)}`;
}

/** What `kind` needs in front of a command whose name is a quoted path. */
function runPrefix(kind: string): string {
  // Only PowerShell: a line that starts with a quoted string is a string there,
  // not a command.
  return kind === "powershell" ? "& " : "";
}

/** How `kind` sequences two commands on one line. */
function chain(kind: string): string {
  // PowerShell 5.1 has no `&&`; `;` runs the second command either way, which is
  // the best available without sniffing the version.
  return kind === "powershell" ? "; " : " && ";
}

function loadConfig(): InterpreterConfig[] {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function useRunner() {
  const [config, setConfig] = useState<InterpreterConfig[]>(loadConfig);
  const [output, setOutput] = useState<RunLine[]>([]);
  const [running, setRunning] = useState(false);
  const [lastExit, setLastExit] = useState<RunExit | null>(null);
  const runIdRef = useRef<string | null>(null);
  // Non-null while a PTY session owns the current run, which is also how the
  // renderer knows to show the terminal instead of the text panel.
  const terminalIdRef = useRef<string | null>(null);
  const sinkRef = useRef<TerminalSink | null>(null);
  const pendingOutputRef = useRef<PendingOutput[]>([]);
  const outputTimerRef = useRef<number | null>(null);
  // Source of `RunLine.seq`.
  const seqRef = useRef(0);
  // Size of the terminal viewport, kept current by the fit addon so a session
  // opened after a panel resize starts life at the right width.
  const sizeRef = useRef({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });

  // --- Interactive shell -----------------------------------------------------
  // Deliberately a second set of refs rather than a second slot in the ones
  // above: the two sessions have unrelated lifetimes, and every one of these
  // would otherwise have to be told which session it means.
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [shell, setShell] = useState<ShellSession | null>(null);
  const shellIdRef = useRef<string | null>(null);
  const shellSinkRef = useRef<TerminalSink | null>(null);
  // The opening banner, held until there is a renderer for it. The pane mounts
  // a render after `setShell`, which is later than the moment the session is
  // created, so writing it straight to the sink would drop the first line.
  const shellBannerRef = useRef<Uint8Array | null>(null);
  // The shell's screen, captured as its pane is torn down, tagged with the
  // session it came from. Closing the panel unmounts the xterm but not the
  // session, so this is what puts the terminal back rather than an empty box —
  // and the tag is what stops it being replayed into a different shell.
  const shellSnapshotRef = useRef<{ id: string; screen: string } | null>(null);
  const shellSizeRef = useRef({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  // Which shell `shellIdRef` is running, and the directory it is last known to
  // be in. The kind decides the syntax of an injected command line; the
  // directory decides whether one has to be injected at all.
  const shellKindRef = useRef<string | null>(null);
  const shellCwdRef = useRef<string | null>(null);
  // Command lines waiting for a shell that has just been spawned to come up, in
  // the order they were asked for. A queue rather than a single slot because two
  // callers can ask for a session at once — see `openingShellRef`.
  const pendingInjectRef = useRef<string[]>([]);
  const injectTimerRef = useRef<number | null>(null);
  // Writes already spent on the line at the head of the queue. Bounded so a
  // shell that never comes up does not get typed into forever.
  const injectTriesRef = useRef(0);
  // A write for the head of that queue is in flight. The queue is only shortened
  // after the backend accepts the write, so without this two callers arriving
  // together would both send the same command line.
  const injectBusyRef = useRef(false);
  // The session that is currently being brought up, if any.
  //
  // `openShell` begins by closing whatever session exists, so two overlapping
  // calls are destructive: the later one's `closeShell` lands while the earlier
  // one is still awaiting `pty_open`, killing the session it just created —
  // which is also where its queued command line goes (`closeShell` empties the
  // queue). The user sees the terminal flash and then nothing runs. Anyone who
  // arrives while this is set joins the session that is coming up instead.
  const openingShellRef = useRef<boolean>(false);

  const discardPendingOutput = useCallback(() => {
    if (outputTimerRef.current !== null) window.clearTimeout(outputTimerRef.current);
    outputTimerRef.current = null;
    pendingOutputRef.current = [];
  }, []);

  const flushPendingOutput = useCallback(() => {
    if (outputTimerRef.current !== null) window.clearTimeout(outputTimerRef.current);
    outputTimerRef.current = null;
    const pending = pendingOutputRef.current;
    if (pending.length === 0) return;
    pendingOutputRef.current = [];
    // Identity is stamped here rather than inside the state updater: an updater
    // has to be pure, and a counter advanced inside one would move twice for a
    // single batch if React ever re-ran it.
    for (const item of pending) {
      if (item.kind === "line") item.value.seq = seqRef.current++;
    }
    setOutput((prev) => {
      const next = [...prev];
      for (const item of pending) {
        if (item.kind === "line") {
          next.push(item.value);
        } else {
          const text = item.values.join("");
          const last = next[next.length - 1];
          if (last && last.id === "stream") {
            // Replacing the entry is what tells the renderer this row changed;
            // its `seq` deliberately stays put so it is the only row that does.
            next[next.length - 1] = { ...last, line: last.line + text };
          } else {
            // The tail row is re-created on every batch anyway, so it does not
            // need an identity to survive anything.
            next.push({ id: "stream", stream: "stdout", line: text });
          }
        }
      }
      // Keep the transcript bounded: see MAX_OUTPUT_LINES. The oldest lines go
      // rather than the newest, so what the user was watching stays put — and
      // the copy that was dropped is in the run's log file.
      const overflow = next.length - MAX_OUTPUT_LINES;
      if (overflow > 0) next.splice(0, overflow);
      return next;
    });
  }, []);

  const queueOutput = useCallback((item: PendingOutput) => {
    pendingOutputRef.current.push(item);
    if (outputTimerRef.current === null) {
      outputTimerRef.current = window.setTimeout(flushPendingOutput, OUTPUT_BATCH_MS);
    }
  }, [flushPendingOutput]);

  useEffect(() => discardPendingOutput, [discardPendingOutput]);

  useEffect(() => {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch {
      /* ignore */
    }
  }, [config]);

  // Stream run output / exit events for the current run.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unOut: (() => void) | undefined;
    let unExit: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      unOut = await listen<RunOutputBatch>(OUT_EVENT, (e) => {
        if (cancelled || e.payload.id !== runIdRef.current) return;
        // One message, many lines: queue them individually so the flush below
        // still merges them into a single state update.
        for (const item of e.payload.lines) {
          queueOutput({
            kind: "line",
            value: { id: e.payload.id, stream: item.stream, line: item.line },
          });
        }
      });
      unExit = await listen<RunExit>(EXIT_EVENT, (e) => {
        if (cancelled) return;
        if (e.payload.id !== runIdRef.current) return;
        flushPendingOutput();
        setRunning(false);
        setLastExit({
          id: e.payload.id,
          code: e.payload.code,
          log: e.payload.log ?? null,
        });
        runIdRef.current = null;
      });
    })();
    return () => {
      cancelled = true;
      unOut?.();
      unExit?.();
    };
  }, [queueOutput, flushPendingOutput]);

  const setInterpreter = useCallback((language: string, patch: Partial<InterpreterConfig>) => {
    setConfig((prev) =>
      prev.map((c) => (c.language === language ? { ...c, ...patch } : c))
    );
  }, []);

  const applyDetected = useCallback(async () => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    try {
      const detected = await invoke<InterpreterConfig[]>("detect_interpreters");
      setConfig((prev) => {
        const map = new Map(prev.map((c) => [c.language, c]));
        for (const d of detected) {
          const existing = map.get(d.language);
          if (d.available) {
            // Refresh the resolved PATH location; keep the user's enable state.
            map.set(d.language, {
              ...(existing ?? { language: d.language, args: d.args, enabled: true, available: true }),
              command: d.command,
              args: d.args,
            });
          } else if (!existing) {
            // Not found on PATH: add a disabled entry for manual configuration.
            map.set(d.language, { ...d, enabled: false });
          }
        }
        return Array.from(map.values());
      });
    } catch (err) {
      console.error("Failed to detect interpreters:", err);
    }
  }, []);

  // Auto-configure from the system PATH on startup.
  useEffect(() => {
    applyDetected();
  }, [applyDetected]);

  /** Ask the backend which interactive shells this machine has, once. */
  const applyShells = useCallback(async () => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    try {
      setShells(await invoke<ShellInfo[]>("detect_shells"));
    } catch (err) {
      console.error("Failed to detect shells:", err);
    }
  }, []);

  useEffect(() => {
    void applyShells();
  }, [applyShells]);

  /**
   * Tear down the current PTY session, if any. Safe to call when nothing is
   * running; the backend treats an unknown id as a no-op.
   */
  const closeTerminal = useCallback(async () => {
    const id = terminalIdRef.current;
    terminalIdRef.current = null;
    if (!id) return;
    try {
      await invoke("pty_close", { id });
    } catch {
      /* already gone */
    }
  }, []);

  /**
   * Write to the shell pane, or hold the bytes until it has mounted.
   *
   * The hold appends rather than replaces: a session is opened before its pane
   * exists, and both the opening banner and a note about where the run is going
   * to happen are queued in that window.
   */
  const writeShell = useCallback((bytes: Uint8Array) => {
    const sink = shellSinkRef.current;
    if (sink) {
      sink.write(bytes);
      return;
    }
    const held = shellBannerRef.current;
    if (!held) {
      shellBannerRef.current = bytes;
      return;
    }
    const merged = new Uint8Array(held.length + bytes.length);
    merged.set(held, 0);
    merged.set(bytes, held.length);
    shellBannerRef.current = merged;
  }, []);

  /**
   * The shell to use for `kind`.
   *
   * An empty preference means "automatic (first available)", which is the
   * default, so an empty or unrecognised `kind` has to fall back to the machine's
   * first available shell rather than match nothing — matching nothing is what
   * made the shell button do nothing at all.
   */
  const resolveShell = useCallback(
    (kind: string): ShellInfo | null =>
      shells.find((s) => s.id === kind && s.available) ??
      shells.find((s) => s.available) ??
      null,
    [shells]
  );

  /**
   * Type the first command line that was waiting for a shell to come up.
   *
   * Two things decide when this runs, and one decides whether it counts as done.
   *
   * *When*: the first bytes the shell prints are the closest thing to a
   * readiness signal there is. The timer is the way out for a shell that comes
   * up silently — and it is armed by `openShell` **after** `pty_open` resolves,
   * not when the line is queued. Opening a session is not instant: it sets the
   * console's code page through a throwaway process before the real shell is
   * even spawned, and only registers the session after that, so a write that
   * arrives in that window is rejected outright.
   *
   * *Done* means "the backend accepted the write". Dequeuing before that is
   * exactly what made the first Run after opening a terminal do nothing and the
   * second one work: the line was dropped at the one moment the session did not
   * exist yet, so there was nothing left to type when the shell did come up.
   * The line therefore stays queued, and the timer comes back for it.
   */
  const flushPendingInject = useCallback(async () => {
    const clear = () => {
      if (injectTimerRef.current !== null) {
        window.clearTimeout(injectTimerRef.current);
        injectTimerRef.current = null;
      }
    };
    const retryLater = () => {
      clear();
      if (pendingInjectRef.current.length === 0) return;
      injectTimerRef.current = window.setTimeout(() => {
        injectTimerRef.current = null;
        void flushPendingInject();
      }, INJECT_DELAY_MS);
    };

    // One write at a time. The shell's own output and the timer can both ask
    // for this within a millisecond of each other, and both would find the same
    // line at the head of the queue — two writes of one command line is a
    // script that runs twice.
    if (injectBusyRef.current) return;

    clear();
    const id = shellIdRef.current;
    // Peeked, not shifted: the line only leaves the queue once it has been
    // accepted. `!id` is just "the session is not there yet" — retried like
    // any other rejection rather than treated as "nothing to do".
    const line = pendingInjectRef.current[0];
    if (!line || !id) {
      if (line) retryLater();
      return;
    }

    injectBusyRef.current = true;
    let accepted = false;
    try {
      await invoke("pty_write", { id, data: line + "\r" });
      accepted = true;
    } catch {
      accepted = false;
    } finally {
      injectBusyRef.current = false;
    }

    // Closed or replaced while the write was in flight: the queue belongs to
    // whoever owns the session now, and this side of it is not ours to touch.
    if (shellIdRef.current !== id) {
      retryLater();
      return;
    }

    if (!accepted) {
      // Either the session is not registered yet (see above) or it has just
      // gone. Giving up after a bounded number of tries keeps a shell that never
      // comes up from being typed into forever.
      if (injectTriesRef.current >= INJECT_MAX_TRIES) {
        pendingInjectRef.current.shift();
        injectTriesRef.current = 0;
      } else {
        injectTriesRef.current += 1;
      }
      retryLater();
      return;
    }

    // Accepted: the shell has it. Anything behind it waits for the next sign of
    // life from the shell, or for the timer.
    pendingInjectRef.current.shift();
    injectTriesRef.current = 0;
    retryLater();
  }, []);

  /**
   * Register (or release) the shell renderer.
   *
   * On attach, the previous pane's screen is replayed first — see
   * `shellSnapshotRef` — and the opening banner second, because the banner is
   * only ever pending on the very first mount of a session.
   */
  const attachShell = useCallback((sink: TerminalSink | null) => {
    shellSinkRef.current = sink;
    if (!sink) return;
    const snap = shellSnapshotRef.current;
    if (snap && snap.id === shellIdRef.current) {
      sink.write(new TextEncoder().encode(snap.screen));
      shellSnapshotRef.current = null;
    }
    if (shellBannerRef.current) {
      sink.write(shellBannerRef.current);
      shellBannerRef.current = null;
    }
  }, []);

  /** Stash the shell's screen, captured as its pane goes away. */
  const rememberShellSnapshot = useCallback((screen: string) => {
    const id = shellIdRef.current;
    // No live session means this is a shell the user has already closed;
    // keeping it would replay one session's screen into the next one.
    if (!id) return;
    shellSnapshotRef.current = { id, screen };
  }, []);

  /**
   * End the shell session — and with it the whole process tree, so a server or
   * a watcher started on the shell's prompt cannot outlive the pane.
   */
  const closeShell = useCallback(async () => {
    const id = shellIdRef.current;
    // Cleared before the state change: the pane's unmount handler runs after
    // this and stores a snapshot only while a session still exists, so this
    // ordering is what keeps a closed shell's screen from coming back.
    shellIdRef.current = null;
    shellBannerRef.current = null;
    shellSnapshotRef.current = null;
    shellKindRef.current = null;
    shellCwdRef.current = null;
    pendingInjectRef.current = [];
    // Released here rather than only by the bring-up that set it: this is also
    // the close-it-by-hand path, and a session the user has just thrown away is
    // not one for the next caller to join.
    openingShellRef.current = false;
    injectTriesRef.current = 0;
    if (injectTimerRef.current !== null) {
      window.clearTimeout(injectTimerRef.current);
      injectTimerRef.current = null;
    }
    setShell(null);
    if (!id) return;
    try {
      await invoke("pty_close", { id });
    } catch {
      /* already gone */
    }
  }, []);

  /**
   * Start `kind` in a fresh pseudo-terminal, replacing any shell already open.
   *
   * Runs the shell itself, not a script: the PTY is handed over to it for the
   * whole session, which is what makes completion, `cd`, history and the rest
   * behave the way they do in a standalone window.
   *
   * `inject` is a command line to type into it once it is up, which is how
   * "run" works — see `runInShell`.
   */
  const openShell = useCallback(
    async (kind: string, cwd?: string | null, inject?: string | null): Promise<boolean> => {
      if (!("__TAURI_INTERNALS__" in window)) return false;
      const info = resolveShell(kind);
      if (!info) return false;

      // A session is already on its way up: join it instead of starting a second
      // one, which the `closeShell` below would destroy mid-flight. See
      // `openingShellRef`.
      if (openingShellRef.current) {
        if (!shellIdRef.current) return false;
        if (inject) pendingInjectRef.current.push(inject);
        return true;
      }

      // One shell at a time: a second pane would mean a second xterm and a
      // second process tree, for something the user has not asked to multiplex.
      // Also clears anything a previous injection left pending.
      await closeShell();
      // Re-checked after the close, because tearing the old session down yields:
      // a second caller arriving in that window has taken the branch above and
      // claimed the bring-up for itself. Joining it here is what keeps the two
      // from each creating a session, one of which nothing would ever own.
      if (openingShellRef.current) {
        if (!shellIdRef.current) return false;
        if (inject) pendingInjectRef.current.push(inject);
        return true;
      }
      openingShellRef.current = true;

      const dir = cwd?.trim() || null;
      const id = `shell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const { cols, rows } = shellSizeRef.current;

      // Queued before the session exists so that the first bytes the shell
      // prints are what sends it; see flushPendingInject. No timer is armed
      // here: `pty_open` does not register the session until after it has set
      // the console's code page, and on a machine where that takes longer than
      // the delay a timer armed now would fire into a session that does not
      // exist yet. It is armed once `pty_open` has returned, below.
      if (inject) pendingInjectRef.current.push(inject);

      const channel = new Channel<PtyChunk>();
      channel.onmessage = (msg) => {
        // A replaced session can still have chunks in flight. Rendering them
        // would splice one shell's output into the other's screen.
        if (shellIdRef.current !== id) return;
        if (msg.kind === "exit") {
          shellIdRef.current = null;
          shellKindRef.current = null;
          shellCwdRef.current = null;
          // A console that has gone cannot receive it, and leaving it queued
          // would type it into whatever session replaces this one.
          pendingInjectRef.current = [];
          setShell((prev) => (prev ? { ...prev, running: false, log: msg.log ?? null } : prev));
          return;
        }
        shellSinkRef.current?.write(new Uint8Array(msg.data));
        // Proof of life: the shell has started and is reading its input.
        if (pendingInjectRef.current.length > 0) void flushPendingInject();
      };

      const name = t(`shell.${info.id}`);
      const banner = dir
        ? t("output.shellBanner", { name, dir })
        : t("output.shellBannerNoDir", { name });
      writeShell(new TextEncoder().encode(`\x1b[2m${banner}\x1b[0m\r\n`));

      shellIdRef.current = id;
      shellKindRef.current = info.id;
      shellCwdRef.current = dir;
      setShell({ id, kind: info.id, running: true, log: null });

      try {
        await invoke("pty_open", {
          id,
          command: info.command,
          args: info.args,
          cwd: dir,
          cols,
          rows,
          onData: channel,
        });
        openingShellRef.current = false;
        // Closed by hand while this was starting: the invite is over, so the
        // process tree must not be left running with nothing on screen to
        // control it. Same check catches a session a later caller has already
        // replaced, which would otherwise be orphaned by the overwrite.
        if (shellIdRef.current !== id) {
          void invoke("pty_close", { id }).catch(() => {
            /* already gone */
          });
          return false;
        }
        // The session exists from here on, so this is the first moment a queued
        // command line can actually be delivered. The shell's own output beats
        // this to it in practice (see `channel.onmessage`); this is the way out
        // for a shell that comes up silently.
        if (pendingInjectRef.current.length > 0) {
          injectTriesRef.current = 0;
          injectTimerRef.current = window.setTimeout(() => {
            injectTimerRef.current = null;
            void flushPendingInject();
          }, INJECT_DELAY_MS);
        }
        return true;
      } catch (err) {
        console.error("Failed to open the shell:", err);
        openingShellRef.current = false;
        shellIdRef.current = null;
        shellKindRef.current = null;
        shellCwdRef.current = null;
        pendingInjectRef.current = [];
        injectTriesRef.current = 0;
        if (injectTimerRef.current !== null) {
          window.clearTimeout(injectTimerRef.current);
          injectTimerRef.current = null;
        }
        setShell({ id, kind: info.id, running: false, log: null });
        writeShell(new TextEncoder().encode(`\x1b[31m${String(err)}\x1b[0m\r\n`));
        return false;
      }
    },
    [closeShell, flushPendingInject, resolveShell, writeShell]
  );

  /**
   * Keystrokes from the shell pane, forwarded verbatim.
   *
   * A submitted line is also what makes the remembered working directory
   * untrustworthy: the user may have just run a `cd`, and a terminal does not
   * report where it ended up. Forgetting is what makes the next run state the
   * directory again instead of running somewhere unexpected.
   */
  const sendShellInput = useCallback(async (data: string): Promise<boolean> => {
    const id = shellIdRef.current;
    if (!id) return false;
    if (data.includes("\n") || data.includes("\r")) shellCwdRef.current = null;
    try {
      await invoke("pty_write", { id, data });
      return true;
    } catch {
      return false;
    }
  }, []);

  /** The shell pane's geometry, so the shell reflows to match the panel. */
  const resizeShell = useCallback((cols: number, rows: number) => {
    if (cols <= 0 || rows <= 0) return;
    const prev = shellSizeRef.current;
    if (prev.cols === cols && prev.rows === rows) return;
    shellSizeRef.current = { cols, rows };
    // Both panes occupy the same box, so a resize measured in one is valid for
    // the other. Mirrored here because a run started while the shell is on
    // screen would otherwise open at whatever width the run pane last had.
    sizeRef.current = { cols, rows };
    const id = shellIdRef.current;
    if (!id) return;
    void invoke("pty_resize", { id, cols, rows }).catch(() => {
      /* session went away */
    });
  }, []);

  const run = useCallback(
    async (
      command: string,
      argsTemplate: string[],
      filePath: string,
      cwd?: string | null,
      hint?: string | null,
      terminal = false
    ): Promise<boolean> => {
      if (!("__TAURI_INTERNALS__" in window)) {
        discardPendingOutput();
        setOutput([{ id: "local", stream: "stderr", line: t("run.desktopOnly") }]);
        return false;
      }

      const hasPlaceholder = argsTemplate.some((a) => a.includes("{file}"));
      const args = argsTemplate.map((a) => a.replaceAll("{file}", filePath));
      if (!hasPlaceholder) args.push(filePath);

      const dir = cwd?.trim() || null;
      const id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      discardPendingOutput();
      runIdRef.current = id;
      setLastExit(null);

      // A previous session's job object still owns its process tree; release it
      // before starting the next run.
      await closeTerminal();

      if (terminal) {
        const header = dir ? t("run.in", { dir }) : t("run.inAppDir");
        const sink = sinkRef.current;
        sink?.clear();
        // The banner goes through the terminal so it scrolls with the output
        // instead of sitting in a separate header the user cannot copy.
        sink?.write(
          new TextEncoder().encode(
            `\x1b[2m${header}\x1b[0m\r\n` + (hint ? `\x1b[2m${hint}\x1b[0m\r\n` : "")
          )
        );
        setOutput([]);
        setRunning(true);
        terminalIdRef.current = id;
        const { cols, rows } = sizeRef.current;
        const channel = new Channel<PtyChunk>();
        channel.onmessage = (msg) => {
          // A closing session can still have chunks in flight. Dropping them
          // matters because a stale chunk would otherwise be rendered as if it
          // belonged to whatever is on screen now.
          if (terminalIdRef.current !== id) return;
          if (msg.kind === "exit") {
            flushPendingOutput();
            terminalIdRef.current = null;
            runIdRef.current = null;
            setRunning(false);
            setLastExit({ id, code: msg.code, log: msg.log ?? null });
            return;
          }
          sinkRef.current?.write(new Uint8Array(msg.data));
        };
        try {
          await invoke("pty_open", { id, command, args, cwd: dir, cols, rows, onData: channel });
          return true;
        } catch (err) {
          console.error("Failed to open terminal:", err);
          terminalIdRef.current = null;
          runIdRef.current = null;
          setRunning(false);
          sinkRef.current?.write(
            new TextEncoder().encode(`\x1b[31m${String(err)}\x1b[0m\r\n`)
          );
          return false;
        }
      }

      const header: RunLine[] = [
        // Tell the user where the script will resolve relative paths. Without
        // this, a script writing "data.txt" appears to work while the file
        // lands somewhere unexpected — or fails outright.
        {
          id: "cwd",
          stream: "stderr",
          notice: true,
          line: dir ? t("run.in", { dir }) : t("run.inAppDir"),
        },
      ];
      if (hint) {
        header.push({ id: "cwd-hint", stream: "stderr", notice: true, line: hint });
      }
      setOutput(header);
      setRunning(true);
      try {
        // The working directory is decided by the caller and validated on the
        // Rust side; passing null means "inherit the app's directory".
        await invoke("run_program", { id, command, args, cwd: dir });
        return true;
      } catch (err) {
        console.error("Failed to run:", err);
        flushPendingOutput();
        setRunning(false);
        runIdRef.current = null;
        setOutput((prev) => [
          ...prev,
          { id, stream: "stderr", line: String(err) },
        ]);
        return false;
      }
    },
    [closeTerminal, discardPendingOutput, flushPendingOutput]
  );

  /**
   * Run a file the way the user asked for it: by putting its command line into
   * the interactive shell, exactly as if it had been typed at the prompt.
   *
   * The alternative — spawning the interpreter straight into a fresh PTY, which
   * is what terminal mode used to do — has two things wrong with it that the user
   * can see. The session dies with the program, so the prompt left on screen
   * cannot be typed into, and nothing about it behaves like a terminal. Going
   * through the shell means the command is echoed, the shell's own completion and
   * history apply to it, and `dir`, `cd` and everything else still work once it
   * has finished.
   *
   * The working directory travels in the command line rather than in the session,
   * because the shell outlives any single run: the file has to run in its own
   * workspace even after the user has wandered off somewhere else in the shell.
   *
   * Returns false when this machine has no shell to run in. That is the caller's
   * signal to fall back to the older path.
   */
  const runInShell = useCallback(
    async (
      kind: string,
      command: string,
      argsTemplate: string[],
      filePath: string,
      cwd?: string | null,
      hint?: string | null
    ): Promise<boolean> => {
      if (!("__TAURI_INTERNALS__" in window)) return false;
      const info = resolveShell(kind);
      if (!info) return false;

      const dir = cwd?.trim() || null;

      // A session left over from an earlier run still owns that run's process
      // tree, and its job object would take a stray `dir` down with it.
      await closeTerminal();
      discardPendingOutput();

      const usesPlaceholder = argsTemplate.some((a) => a.includes("{file}"));
      const tokens = argsTemplate.map((a) => a.replaceAll("{file}", filePath));
      if (!usesPlaceholder) tokens.push(filePath);

      // The shell that is already live decides the syntax. Reopening it because
      // the configured kind differs would throw away whatever the user has going
      // on in there. A session that is still coming up counts for the syntax too,
      // but not for writing: its console is not reading yet, so the line has to
      // travel through the queue `openShell` keeps.
      const starting = openingShellRef.current;
      const live = shellIdRef.current ? shellKindRef.current : null;
      const shellKind = live ?? info.id;
      const invocation =
        runPrefix(shellKind) +
        [command, ...tokens].map((t) => quoteToken(t, shellKind)).join(" ");
      // Only stated when it is not already where it should be: a `cd` the user
      // did not ask for, on every single run, is noise.
      const line =
        dir !== null && shellCwdRef.current !== dir
          ? cdCommand(dir, shellKind) + chain(shellKind) + invocation
          : invocation;

      if (!live || starting) {
        // The command line is handed to `openShell` so that it is queued before
        // the session exists; see flushPendingInject. A bring-up that is already
        // under way is joined there rather than restarted.
        if (!(await openShell(info.id, dir, line))) {
          // The open this was joining has failed, so nothing is coming up and
          // the next caller must start one of its own.
          openingShellRef.current = false;
          return false;
        }
      } else {
        const id = shellIdRef.current;
        if (!id) return false;
        try {
          await invoke("pty_write", { id, data: line + "\r" });
        } catch {
          return false;
        }
      }

      // Written after the session is up rather than before, because opening one
      // clears the queue this would otherwise have gone into. Any note about a
      // surprising directory is dimmed so it does not read as program output.
      if (hint) {
        writeShell(new TextEncoder().encode(`\x1b[2m${hint}\x1b[0m\r\n`));
      }
      // The shell is in this directory now, and remembering that is what keeps
      // the next run from restating it. An exit status from an earlier piped run
      // means nothing here.
      shellCwdRef.current = dir;
      setLastExit(null);
      return true;
    },
    [closeTerminal, discardPendingOutput, openShell, resolveShell, writeShell]
  );

  const stop = useCallback(async () => {
    const termId = terminalIdRef.current;
    if (termId) {
      terminalIdRef.current = null;
      let log: RunLogInfo | null = null;
      try {
        // Closing the session drops its job object, which is what kills the
        // whole process tree rather than just the interpreter. It also hands
        // back the log: a session closed by hand never produces an exit chunk,
        // so this return value is the only chance to surface its output file.
        log = (await invoke<RunLogInfo | null>("pty_close", { id: termId })) ?? null;
      } catch {
        /* ignore */
      }
      flushPendingOutput();
      runIdRef.current = null;
      setRunning(false);
      setLastExit({ id: termId, code: null, log });
      return;
    }
    if (runIdRef.current) {
      try {
        await invoke("stop_program", { id: runIdRef.current });
      } catch {
        /* ignore */
      }
      flushPendingOutput();
      setRunning(false);
      runIdRef.current = null;
      return;
    }
    // Nothing of the app's own is running, so what the user is looking at is the
    // shell. Ctrl+C is how a terminal stops what it is running, and unlike
    // closing the session it leaves the prompt usable afterwards.
    const shellId = shellIdRef.current;
    if (shellId) {
      try {
        await invoke("pty_write", { id: shellId, data: "\x03" });
      } catch {
        /* the session went away */
      }
    }
  }, [flushPendingOutput]);

  /**
   * Feed one line to the running program's stdin. In terminal mode the bytes
   * go straight to the PTY, which echoes them itself — echoing here as well
   * would show every keystroke twice. The plain-text mode still has to echo,
   * because a program reading from a pipe never writes back what it read.
   */
  const sendInput = useCallback(async (text: string): Promise<boolean> => {
    const termId = terminalIdRef.current;
    if (termId) {
      try {
        await invoke("pty_write", { id: termId, data: text + "\n" });
        return true;
      } catch (err) {
        sinkRef.current?.write(
          new TextEncoder().encode(`\x1b[31m${String(err)}\x1b[0m\r\n`)
        );
        return false;
      }
    }
    const id = runIdRef.current;
    if (!id) return false;
    // Echo even an empty line (Enter on a blank line) so the interaction is
    // visible in the transcript.
    flushPendingOutput();
    setOutput((prev) => [
      ...prev,
      { id: "stdin", stream: "stdout", notice: true, line: `> ${text}` },
    ]);
    try {
      await invoke("write_stdin", { id, data: text });
      return true;
    } catch (err) {
      setOutput((prev) => [
        ...prev,
        { id: "stdin-err", stream: "stderr", line: String(err) },
      ]);
      return false;
    }
  }, [flushPendingOutput]);

  /**
   * Send raw terminal input (keystrokes, arrow keys, Ctrl+C). Used by the
   * terminal renderer so interactive TUI programs work; the text panel's
   * input row keeps using `sendInput`, which appends the newline for it.
   */
  const sendRawInput = useCallback(async (data: string): Promise<boolean> => {
    const termId = terminalIdRef.current;
    if (!termId) return false;
    try {
      await invoke("pty_write", { id: termId, data });
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Register the terminal renderer. Returns an unregister callback. */
  const attachTerminal = useCallback((sink: TerminalSink | null) => {
    sinkRef.current = sink;
  }, []);

  /**
   * Report the terminal's current geometry. Remembered even while idle so the
   * next session opens at the right size, and forwarded live so the running
   * program can reflow (e.g. a progress bar that redraws to the new width).
   */
  const resizeTerminal = useCallback((cols: number, rows: number) => {
    if (cols <= 0 || rows <= 0) return;
    const prev = sizeRef.current;
    if (prev.cols === cols && prev.rows === rows) return;
    sizeRef.current = { cols, rows };
    const id = terminalIdRef.current;
    if (!id) return;
    void invoke("pty_resize", { id, cols, rows }).catch(() => {
      /* session went away */
    });
  }, []);

  /**
   * Append lines produced by the terminal bridge. Consecutive fragments join
   * onto the previous entry rather than starting a new row, so a write that
   * happens to split mid-line still reads as one line.
   */
  const appendLines = useCallback((lines: string[]) => {
    if (lines.length === 0) return;
    queueOutput({ kind: "stream", values: lines });
  }, [queueOutput]);

  /**
   * Replace the text transcript wholesale. Used when the terminal hands its
   * scrollback over: the snapshot already contains everything the session has
   * printed, so replacing (rather than appending) keeps repeated switches
   * between the two views from duplicating the output.
   */
  const setTranscript = useCallback((lines: string[]) => {
    discardPendingOutput();
    // Same budget as the live transcript, and trimmed from the front for the
    // same reason: the terminal's scrollback can be deeper than the text view
    // is willing to render, and adopting all of it would hand React a list the
    // size of which the renderer was never meant to handle.
    const overflow = lines.length - MAX_OUTPUT_LINES;
    const kept = overflow > 0 ? lines.slice(overflow) : lines;
    setOutput(
      kept.map((line) => ({
        id: "stream",
        stream: "stdout" as const,
        line,
        seq: seqRef.current++,
      }))
    );
  }, [discardPendingOutput]);

  const clearOutput = useCallback(() => {
    discardPendingOutput();
    setOutput([]);
    setLastExit(null);
    // Only wipe the scrollback when there is a terminal to wipe; clearing it
    // mid-run would destroy the record of what the program has printed.
    if (!terminalIdRef.current) sinkRef.current?.clear();
  }, [discardPendingOutput]);

  const showLocal = useCallback((line: string) => {
    if (terminalIdRef.current) {
      sinkRef.current?.write(new TextEncoder().encode(`\x1b[2m${line}\x1b[0m\r\n`));
      return;
    }
    discardPendingOutput();
    setOutput([{ id: "local", stream: "stderr", line }]);
    setLastExit(null);
  }, [discardPendingOutput]);

  return {
    config,
    setInterpreter,
    applyDetected,
    shells,
    applyShells,
    shell,
    openShell,
    closeShell,
    attachShell,
    rememberShellSnapshot,
    sendShellInput,
    resizeShell,
    output,
    running,
    lastExit,
    run,
    runInShell,
    stop,
    sendInput,
    sendRawInput,
    attachTerminal,
    resizeTerminal,
    appendLines,
    setTranscript,
    clearOutput,
    showLocal,
  };
}
