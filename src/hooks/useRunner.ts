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
}

export interface RunExit {
  id: string;
  code: number | null;
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
  // Size of the terminal viewport, kept current by the fit addon so a session
  // opened after a panel resize starts life at the right width.
  const sizeRef = useRef({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });

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
    setOutput((prev) => {
      const next = [...prev];
      for (const item of pending) {
        if (item.kind === "line") {
          next.push(item.value);
        } else {
          const text = item.values.join("");
          const last = next[next.length - 1];
          if (last && last.id === "stream") {
            next[next.length - 1] = { ...last, line: last.line + text };
          } else {
            next.push({ id: "stream", stream: "stdout", line: text });
          }
        }
      }
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
      unOut = await listen<RunLine>(OUT_EVENT, (e) => {
        if (!cancelled && e.payload.id === runIdRef.current) {
          queueOutput({ kind: "line", value: e.payload });
        }
      });
      unExit = await listen<RunExit>(EXIT_EVENT, (e) => {
        if (cancelled) return;
        if (e.payload.id !== runIdRef.current) return;
        flushPendingOutput();
        setRunning(false);
        setLastExit({ id: e.payload.id, code: e.payload.code });
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
            setLastExit({ id, code: msg.code });
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

  const stop = useCallback(async () => {
    const termId = terminalIdRef.current;
    if (termId) {
      terminalIdRef.current = null;
      try {
        // Closing the session drops its job object, which is what kills the
        // whole process tree rather than just the interpreter.
        await invoke("pty_close", { id: termId });
      } catch {
        /* ignore */
      }
      flushPendingOutput();
      runIdRef.current = null;
      setRunning(false);
      return;
    }
    if (runIdRef.current) {
      try {
        await invoke("stop_program", { id: runIdRef.current });
      } catch {
        /* ignore */
      }
    }
    flushPendingOutput();
    setRunning(false);
    runIdRef.current = null;
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
    setOutput(
      lines.map((line) => ({ id: "stream", stream: "stdout" as const, line }))
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
    output,
    running,
    lastExit,
    run,
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
