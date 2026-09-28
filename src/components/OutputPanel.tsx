import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunExit, RunLine, ShellSession, TerminalSink } from "../hooks/useRunner";
import { MAX_OUTPUT_LINES } from "../hooks/useRunner";
import EditorContextMenu, { type ContextMenuItem } from "./EditorContextMenu";
import VerticalResizeHandle from "./VerticalResizeHandle";
import TerminalOutput, { type TerminalHandle } from "./TerminalOutput";
import { copyText } from "../utils/clipboard";
import { getI18nLocale, t } from "../i18n";

interface OutputPanelProps {
  visible: boolean;
  output: RunLine[];
  running: boolean;
  lastExit: RunExit | null;
  onClear: () => void;
  onStop: () => void;
  onClose: () => void;
  /** Panel body height in px, excluding the header. Draggable by the user. */
  height: number;
  onResize: (delta: number) => void;
  /** Sends one line to the running program's stdin. */
  onSendInput: (text: string) => Promise<boolean>;
  /** Sends raw terminal bytes (keystrokes) to the running program. */
  onSendRawInput: (data: string) => Promise<boolean>;
  /** Opens a run's log file in the editor. */
  onOpenLog: (path: string) => void;
  /** Registers the active renderer so the runner can push bytes or a banner. */
  onAttachTerminal: (sink: TerminalSink | null) => void;
  onTerminalResize: (cols: number, rows: number) => void;
  /**
   * Append already-split lines to the text view's transcript. Terminal output
   * goes through here rather than the runner's own state so consecutive
   * fragments join into one logical line.
   */
  onAppendLines: (lines: string[]) => void;
  /**
   * Replace the text transcript. The terminal's scrollback already contains
   * everything the session printed, so adopting it is a replacement.
   */
  onSetTranscript: (lines: string[]) => void;
  /** Render with xterm.js instead of the plain-text view. */
  terminalMode: boolean;
  onSetTerminalMode: (on: boolean) => void;
  /** Editor font, so the terminal matches whatever the user picked. */
  fontSize: number;
  fontFamily: string;
  /** Session-wide input history, shared across runs. */
  inputHistory: string[];
  onRememberInput: (text: string) => void;
  /** The live (or most recent) shell session, if one has been started. */
  shell: ShellSession | null;
  /** Starts (`kind` empty = the preferred shell) or restarts a shell. */
  onOpenShell: (kind: string) => void;
  onCloseShell: () => void;
  /** Raw keystrokes for the shell session. */
  onShellInput: (data: string) => Promise<boolean>;
  /** Registers the shell renderer, so output has somewhere to go. */
  onAttachShell: (sink: TerminalSink | null) => void;
  /**
   * The shell's screen as it stood if its renderer is torn down while the
   * session survives. Hiding the panel no longer tears the renderer down.
   */
  onShellSnapshot: (snapshot: string) => void;
  onShellResize: (cols: number, rows: number) => void;
}

interface MenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

// The drag strip is 6px, the header row is `h-9` (36px) and the input row is
// `h-8` (32px, plain-text mode only); the body is whatever the user dragged to.
const RESIZE_HANDLE_HEIGHT = 6;
const HEADER_HEIGHT = 36;
const INPUT_HEIGHT = 32;
// The "this is not the whole run" bar, when it is showing. `py-1` (8px) plus a
// 12px line at the default 16px line height, plus its 1px border.
const NOTICE_HEIGHT = 26;

/**
 * Cheap ANSI stripper used only when handing terminal output to the plain-text
 * panel, which cannot render escape sequences — leaving them in would fill the
 * transcript with `[0m` noise. Handles CSI, OSC and the two-character escapes;
 * enough for what programs actually emit.
 */
function stripAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-Z\\-_]/g, "");
}

/**
 * Carriage returns in terminal output mean "overwrite this line", which a
 * scrolling list cannot express. Keeping only the text after the last `\r`
 * matches what the user already saw in the terminal (progress bars collapse to
 * their final state instead of printing a row per frame).
 */
function collapseCarriageReturns(text: string): string[] {
  const merged = text
    .split("\r\n")
    .map((line) => {
      const parts = line.split("\r");
      return parts[parts.length - 1];
    })
    .join("\n");
  return merged.split("\n");
}

/**
 * One transcript row.
 *
 * Memoised because the whole list is re-rendered on every output batch. The
 * transcript keeps the entries that did not change and tags each one with a
 * stable `seq`, so React can skip every row except the ones that just arrived.
 * Without this the cost of a batch grows with the length of the run — which is
 * the cost MAX_OUTPUT_LINES exists to bound in the first place.
 */
const OutputRow = memo(function OutputRow({ line }: { line: RunLine }) {
  return (
    <div
      className={
        (line.notice
          ? "text-faint italic"
          : line.stream === "stderr"
            ? "text-danger"
            : "text-sub") + " whitespace-pre-wrap break-all"
      }
    >
      {line.line}
    </div>
  );
});

export default function OutputPanel({
  visible,
  output,
  running,
  lastExit,
  onClear,
  onStop,
  onClose,
  height,
  onResize,
  onSendInput,
  onSendRawInput,
  onOpenLog,
  onAttachTerminal,
  onTerminalResize,
  onAppendLines,
  onSetTranscript,
  terminalMode,
  onSetTerminalMode,
  fontSize,
  fontFamily,
  inputHistory,
  onRememberInput,
  shell,
  onOpenShell,
  onCloseShell,
  onShellInput,
  onAttachShell,
  onShellSnapshot,
  onShellResize,
}: OutputPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [draft, setDraft] = useState("");
  // -1 means "editing a fresh line"; anything >= 0 indexes into inputHistory
  // from the end, which is the direction ↑ walks.
  const [historyPos, setHistoryPos] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const shellTermHandleRef = useRef<TerminalHandle | null>(null);

  // Raw terminal bytes that arrived while the text view was showing. They are
  // decoded, stripped of escape sequences and split into lines before reaching
  // `output`: the text panel cannot render a cursor move, so leaving escapes in
  // shows up as literal garbage.
  const textBridgeRef = useRef("");
  // Reused across chunks on purpose. A fresh `TextDecoder` per call discards the
  // half of a multi-byte character that straddles two reads and emits U+FFFD in
  // its place, which turns any Chinese log line into mojibake.
  const decoderRef = useRef(new TextDecoder());
  const termHandleRef = useRef<TerminalHandle | null>(null);

  // Whether the viewport is pinned to the tail. The app root sets
  // `user-select: none`, so a drag to select output must never have the panel
  // scroll out from under the pointer — only follow new lines while the user is
  // already sitting at the bottom.
  const stickRef = useRef(true);

  // The shell has no transcript and no stdin row — its PTY takes keystrokes
  // directly — so both of those belong to the run side alone.
  const hasShell = shell !== null;
  /**
   * Which of the three surfaces is on screen.
   *
   * There is exactly one control behind this and it is the terminal switch: on
   * means a terminal is open, and with the terminal on a shell *is* what the
   * panel shows — a run happens inside it (see `useRunner.runInShell`), so there
   * would be nothing else to look at. Nothing here is a separate "which tab am I
   * on" state any more; that was what let the panel sit on the shell while the
   * header said the terminal was off.
   *
   * The run pane keeps its job regardless: a machine with no shell has the
   * interpreter spawned straight into it, which is why it stays mounted.
   */
  const showShell = hasShell && terminalMode;
  const showText = !showShell && !terminalMode;
  const showRunTerminal = !showShell && terminalMode;

  // A full transcript is trimmed to exactly MAX_OUTPUT_LINES, so reaching the
  // cap is what says lines were dropped. A run that happens to produce exactly
  // that many lines would be reported the same way; the cost of that is one
  // unnecessary sentence, and the log file is identical either way.
  const truncated = output.length >= MAX_OUTPUT_LINES;
  // Pulled out of `lastExit` because the bar below is built inside an `&&` chain,
  // and TypeScript will not carry a narrowing into a closure created there.
  const runLog = lastExit?.log ?? null;
  // The bar belongs to the plain-text view only: the terminal scrolls its own
  // history, and a shell has no transcript to trim in the first place.
  const showTruncated = showText && truncated;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  /**
   * The active renderer, in the shape the runner expects.
   *
   * xterm always receives the raw bytes — it is the only renderer that can act
   * on escape sequences. The text transcript is built only while the text view
   * is the visible one, so a noisy run in terminal mode does not churn React
   * state on output nobody is reading; switching over is handled by handing the
   * terminal's scrollback across (see the effect below).
   */
  const sink = useMemo<TerminalSink>(
    () => ({
      write: (data) => {
        termHandleRef.current?.write(data);
        if (terminalMode) return;
        textBridgeRef.current += decoderRef.current.decode(data, { stream: true });
        const lines = collapseCarriageReturns(stripAnsi(textBridgeRef.current));
        // The tail is a partial line until a newline arrives.
        textBridgeRef.current = lines.pop() ?? "";
        if (lines.length > 0) onAppendLines(lines);
      },
      clear: () => {
        textBridgeRef.current = "";
        decoderRef.current = new TextDecoder();
        termHandleRef.current?.clear();
      },
      focus: () => termHandleRef.current?.focus(),
      refit: () => termHandleRef.current?.refit(),
    }),
    [terminalMode, onAppendLines]
  );

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  // Publish the sink to the runner, and re-publish whenever it changes so a run
  // that is already in flight keeps writing to whichever view is on screen now.
  useEffect(() => {
    onAttachTerminal(sink);
    return () => onAttachTerminal(null);
  }, [sink, onAttachTerminal]);

  // Hand the terminal's scrollback to the text view when the user turns the
  // terminal off. The snapshot already covers the whole session, so the
  // transcript is replaced rather than extended — that is what keeps repeated
  // switches between the two views from duplicating everything.
  const wasTerminalRef = useRef(terminalMode);
  useEffect(() => {
    if (wasTerminalRef.current && !terminalMode) {
      const snapshot = termHandleRef.current?.snapshot();
      if (snapshot) onSetTranscript(collapseCarriageReturns(stripAnsi(snapshot)));
      // Output produced from here on arrives through the bridge instead, so the
      // leftover tail from a previous text-mode stretch must not be re-emitted.
      textBridgeRef.current = "";
      decoderRef.current = new TextDecoder();
    }
    wasTerminalRef.current = terminalMode;
  }, [terminalMode, onSetTranscript]);

  // A program that ends without a trailing newline leaves its last line in the
  // bridge. Flush it when the run finishes, otherwise that line is invisible.
  const wasRunningRef = useRef(running);
  useEffect(() => {
    if (wasRunningRef.current && !running && !terminalMode) {
      const [tail] = collapseCarriageReturns(textBridgeRef.current);
      textBridgeRef.current = "";
      if (tail) onAppendLines([tail]);
    }
    wasRunningRef.current = running;
  }, [running, terminalMode, onAppendLines]);

  const handleTerminalReady = useCallback((api: TerminalHandle | null) => {
    termHandleRef.current = api;
  }, []);

  const handleTerminalData = useCallback(
    (data: string) => {
      void onSendRawInput(data);
    },
    [onSendRawInput]
  );

  /**
   * The run pane is `display:none` while the shell view is showing, and a fit
   * against a zero-sized box reports a nonsense geometry. Forwarding that would
   * resize a live program to a column or two, so only the visible pane's size
   * reaches the backend.
   */
  const handleRunResize = useCallback(
    (cols: number, rows: number) => {
      if (!visible || !showRunTerminal) return;
      onTerminalResize(cols, rows);
    },
    [visible, showRunTerminal, onTerminalResize]
  );

  /**
   * The shell renderer. Registered for as long as its session lives.
   *
   * If the renderer is torn down, capture its screen before xterm is disposed.
   * Normal panel hiding leaves it mounted so output keeps flowing into it.
   */
  const handleShellReady = useCallback(
    (api: TerminalHandle | null) => {
      if (api) {
        shellTermHandleRef.current = api;
      } else {
        onShellSnapshot(shellTermHandleRef.current?.snapshot() ?? "");
        shellTermHandleRef.current = null;
      }
      onAttachShell(api);
    },
    [onAttachShell, onShellSnapshot]
  );

  const handleShellData = useCallback(
    (data: string) => {
      void onShellInput(data);
    },
    [onShellInput]
  );

  /** Same visibility rule as the run pane, for the same reason. */
  const handleShellResize = useCallback(
    (cols: number, rows: number) => {
      if (!visible || !showShell) return;
      onShellResize(cols, rows);
    },
    [visible, showShell, onShellResize]
  );

  // A terminal that has just been switched on should be ready to type into —
  // otherwise the first keystroke goes nowhere and it looks broken. Deferred
  // because the pane is still `display:none` during the render that reveals it,
  // and a hidden element cannot take focus.
  useEffect(() => {
    if (!visible || !showShell || !shell) return;
    const id = window.setTimeout(() => shellTermHandleRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [visible, showShell, shell?.id]);

  const historyIndex = useCallback(
    (pos: number) => (pos < 0 ? -1 : inputHistory.length - 1 - pos),
    [inputHistory.length]
  );

  const submit = useCallback(async () => {
    if (!running) return; // Nothing is reading stdin — do not send into the void.
    // Remember non-empty lines only; re-running the same answer repeatedly
    // would otherwise bury the useful entries.
    if (draft.trim().length > 0) onRememberInput(draft);
    setHistoryPos(-1);
    const text = draft;
    setDraft("");
    await onSendInput(text);
    // Keep typing in the terminal: after answering a prompt the user usually
    // has more to send.
    if (visible) termHandleRef.current?.focus();
  }, [draft, running, visible, onSendInput, onRememberInput]);

  const handleHistoryKey = useCallback(
    (dir: -1 | 1) => {
      if (inputHistory.length === 0) return;
      const next = historyPos + (dir === -1 ? 1 : -1);
      // ↑ walks backwards through history; ↓ walks forward and lands on the
      // empty draft once past the newest entry.
      const idx = historyIndex(next);
      if (next < 0) {
        setHistoryPos(-1);
        setDraft("");
      } else if (idx >= 0 && idx < inputHistory.length) {
        setHistoryPos(next);
        setDraft(inputHistory[idx]);
      }
    },
    [historyPos, inputHistory, historyIndex]
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        handleHistoryKey(-1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        handleHistoryKey(1);
      }
    },
    [submit, handleHistoryKey]
  );

  /** True when the current document selection lives inside the output area. */
  const selectionInPanel = useCallback(() => {
    const el = scrollRef.current;
    const sel = document.getSelection();
    if (!el || !sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const node = sel.getRangeAt(0).commonAncestorContainer;
    return el.contains(node.nodeType === Node.TEXT_NODE ? node.parentNode : node);
  }, []);

  // Whichever pane is on screen is the one "Clear" is expected to empty.
  const clearActive = useCallback(() => {
    if (showShell) {
      shellTermHandleRef.current?.clear();
      return;
    }
    onClear();
  }, [showShell, onClear]);

  const copySelection = useCallback(async () => {
    const text = document.getSelection()?.toString() ?? "";
    await copyText(text);
  }, []);

  const copyAll = useCallback(async () => {
    const text = output.map((l) => l.line).join("\n");
    await copyText(text);
  }, [output]);

  const selectAll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !el.textContent) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, hasSelection: selectionInPanel() });
    },
    [selectionInPanel]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "a") {
        e.preventDefault();
        selectAll();
      } else if (key === "c" && !selectionInPanel()) {
        // Nothing selected in the panel: copy the whole buffer, matching the
        // behaviour of terminal-style output panes.
        e.preventDefault();
        void copyAll();
      }
    },
    [selectAll, selectionInPanel, copyAll]
  );

  const menuItems = useMemo<ContextMenuItem[]>(
    () => [
      {
        label: t("menu.copy"),
        shortcut: "Ctrl+C",
        disabled: !menu?.hasSelection,
        onSelect: () => void copySelection(),
      },
      {
        label: t("output.copyAll"),
        disabled: output.length === 0,
        onSelect: () => void copyAll(),
      },
      {
        label: t("output.selectAll"),
        shortcut: "Ctrl+A",
        disabled: output.length === 0,
        onSelect: selectAll,
      },
      {
        label: t("output.clear"),
        disabled: output.length === 0,
        onSelect: onClear,
      },
    ],
    // getI18nLocale() is part of the keys so the labels are rebuilt when the
    // language changes; without it the memo would keep the previous strings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menu?.hasSelection, output.length, copySelection, copyAll, selectAll, onClear, getI18nLocale()]
  );

  return (
    <div
      className="shrink-0 bg-panel border-t border-line-soft flex flex-col"
      // Every child that is not the body has to be charged here, or it eats the
      // body's height instead of the panel's: the stdin row (run view, plain
      // text only), the truncation bar (only while it is showing), and the drag
      // strip above the header. The strip went unaccounted for until now, which
      // made the body 6px shorter than the height the user had dragged to.
      style={{
        display: visible ? "flex" : "none",
        height:
          RESIZE_HANDLE_HEIGHT +
          height +
          HEADER_HEIGHT +
          (showText ? INPUT_HEIGHT : 0) +
          (showTruncated ? NOTICE_HEIGHT : 0),
      }}
    >
      <VerticalResizeHandle onDrag={onResize} />
      <div className="h-9 flex items-center gap-2 px-3 border-b border-line-soft shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wide text-faint">{t("output.title")}</span>
        {/* Status belongs to whichever session is on screen: an exit code from a
            piped run means nothing while the user is looking at a shell. The
            shell is checked first because with the terminal on it is what a run
            shows up in. */}
        {showShell && shell ? (
          <span className="text-xs text-sub flex items-center gap-1.5">
            {shell.running && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />}
            {t(`shell.${shell.kind}`)}
          </span>
        ) : running ? (
          <span className="text-xs text-accent flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            {t("output.running")}
          </span>
        ) : lastExit ? (
          lastExit.code === null ? (
            // Stopping by hand has no exit status worth showing; the code the
            // OS reports for a killed process is noise.
            <span className="text-xs text-sub">{t("output.stopped")}</span>
          ) : lastExit.code === 0 ? (
            <span className="text-xs text-sub">{t("output.exited", { code: 0 })}</span>
          ) : (
            <span className="text-xs text-danger">{t("output.exited", { code: lastExit.code })}</span>
          )
        ) : null}
        <div className="flex-1" />
        {/* The complete output is still written to a file for every run, but
            there is no button for it here: the terminal scrolls its own history
            and the transcript is already capped at as much as this panel can
            render, so the file is a safety net rather than something to go and
            open. The one place it is offered is where the transcript really did
            drop lines — the bar below links straight to it. */}
        {/* There is deliberately no "Shell" button here: the terminal switch
            below opens one (see `onSetTerminalMode`), and two buttons that both
            produce a terminal is one too many. What replaces it is the
            "Restart" button, which appears only for a shell that has exited. */}
        {showShell && shell && !shell.running && (
          <button
            onClick={() => onOpenShell(shell.kind)}
            title={t("output.shellRestartTitle")}
            className="px-2 py-0.5 rounded text-xs text-sub hover:text-ink hover:bg-hover transition-colors"
          >
            {t("output.shellRestart")}
          </button>
        )}
        {/* The terminal's only switch, so it belongs to both views: whether a
            terminal is open is not a property of the run view. */}
        <button
          onClick={() => onSetTerminalMode(!terminalMode)}
          title={terminalMode ? t("output.terminal.onTitle") : t("output.terminal.offTitle")}
          className={`px-2 py-0.5 rounded text-xs transition-colors ${
            terminalMode
              ? "text-accent bg-hover"
              : "text-sub hover:text-ink hover:bg-hover"
          }`}
        >
          {terminalMode ? t("output.terminal.on") : t("output.terminal.off")}
        </button>
        <button
          onClick={clearActive}
          className="px-2 py-0.5 rounded text-xs text-sub hover:text-ink hover:bg-hover transition-colors"
        >
          {t("output.clear")}
        </button>
        {/* Stop means two different things and both are worth offering: for a
            piped run it ends the process the app started; for a shell it is a
            Ctrl+C, which stops whatever is in the foreground without taking the
            prompt down with it. */}
        {(running || (showShell && shell?.running)) && (
          <button
            onClick={onStop}
            title={showShell ? t("output.ctrlCTitle") : undefined}
            className="px-2 py-0.5 rounded text-xs text-danger hover:bg-hover transition-colors"
          >
            {t("output.stop")}
          </button>
        )}
        {showShell && (
          <button
            onClick={onCloseShell}
            title={t("output.shellCloseTitle")}
            className="px-2 py-0.5 rounded text-xs text-danger hover:bg-hover transition-colors"
          >
            {t("output.shellClose")}
          </button>
        )}
        <button
          onClick={onClose}
          title={t("output.closeTitle")}
          className="w-5 h-5 rounded flex items-center justify-center text-faint hover:text-ink hover:bg-hover transition-colors text-sm"
        >
          ×
        </button>
      </div>
      {/* Says out loud what the transcript cannot: it is a window, not the
          whole run. Only shown while the cap is actually trimming lines, and
          it opens the file that has all of them. */}
      {showTruncated &&
        (runLog ? (
          <button
            onClick={() => onOpenLog(runLog.path)}
            title={t("output.logTitle", {
              path: runLog.path,
              lines: runLog.lines,
            })}
            className="shrink-0 px-3 py-1 border-b border-line-soft text-left text-xs text-faint hover:text-ink hover:bg-hover transition-colors"
          >
            {t("output.truncatedCap", {
              max: MAX_OUTPUT_LINES,
              total: runLog.lines,
            })}
          </button>
        ) : (
          <div className="shrink-0 px-3 py-1 border-b border-line-soft text-xs text-faint">
            {t("output.truncatedNoLog", { max: MAX_OUTPUT_LINES })}
          </div>
        ))}
      {/* Both run renderers stay mounted; only visibility is toggled.
          Unmounting the terminal mid-run would throw away its scrollback, and
          unmounting the text view would reset its scroll position. */}
      <div
        className={`flex-1 min-h-0 select-text cursor-text ${showRunTerminal ? "" : "hidden"}`}
        style={{ padding: "4px 6px 0 10px" }}
      >
        <TerminalOutput
          visible={visible && showRunTerminal}
          onReady={handleTerminalReady}
          onData={handleTerminalData}
          onResize={handleRunResize}
          fontSize={fontSize}
          fontFamily={fontFamily}
        />
      </div>
      {/* The shell pane stays mounted for as long as its session exists, not
          merely while it is the visible one: hiding keeps its scrollback, while
          unmounting would throw the session's history away every time the user
          looked at a run. */}
      {shell && (
        <div
          className={`flex-1 min-h-0 select-text cursor-text ${showShell ? "" : "hidden"}`}
          style={{ padding: "4px 6px 0 10px" }}
        >
          <TerminalOutput
            visible={visible && showShell}
            onReady={handleShellReady}
            onData={handleShellData}
            onResize={handleShellResize}
            fontSize={fontSize}
            fontFamily={fontFamily}
          />
        </div>
      )}
      <div
        ref={scrollRef}
        tabIndex={-1}
        onScroll={handleScroll}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        className={`output-text flex-1 overflow-auto px-3 py-2 font-mono text-xs leading-[1.5] select-text cursor-text outline-none ${
          showText ? "" : "hidden"
        }`}
      >
        {output.length === 0 ? (
          <span className="text-faint">{t("output.none")}</span>
        ) : (
          output.map((l, i) => <OutputRow key={l.seq ?? `i${i}`} line={l} />)
        )}
      </div>
      {/* stdin row. Only the run view's plain-text mode needs it: a program
          reading from a pipe has no other way to receive a line, whereas both
          the terminal and the shell take keystrokes directly. Hidden (and its
          height reclaimed) elsewhere so the panel is nothing but output. */}
      {showText && (
        <div className="h-8 shrink-0 flex items-center gap-2 px-3 border-t border-line-soft">
          <span className={`font-mono text-xs ${running ? "text-accent" : "text-faint"}`}>›</span>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setHistoryPos(-1);
            }}
            onKeyDown={handleInputKeyDown}
            disabled={!running}
            spellCheck={false}
            autoComplete="off"
            placeholder={running ? t("output.inputPlaceholder") : t("output.inputIdle")}
            title={running ? t("output.inputTitle") : t("output.inputIdleTitle")}
            className="flex-1 min-w-0 bg-transparent outline-none font-mono text-xs text-ink placeholder:text-faint disabled:cursor-not-allowed disabled:placeholder:text-faint"
          />
          <button
            onClick={() => void submit()}
            disabled={!running}
            title={t("output.sendTitle")}
            className="px-2 py-0.5 rounded text-xs text-sub hover:text-ink hover:bg-hover transition-colors disabled:opacity-40 disabled:text-faint disabled:hover:bg-transparent"
          >
            {t("output.send")}
          </button>
        </div>
      )}
      {menu && (
        <EditorContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
