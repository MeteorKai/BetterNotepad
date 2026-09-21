import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunExit, RunLine, TerminalSink } from "../hooks/useRunner";
import EditorContextMenu, { type ContextMenuItem } from "./EditorContextMenu";
import VerticalResizeHandle from "./VerticalResizeHandle";
import TerminalOutput, { type TerminalHandle } from "./TerminalOutput";
import { copyText } from "../utils/clipboard";
import { getI18nLocale, t } from "../i18n";

interface OutputPanelProps {
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
}

interface MenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

// The header row is `h-9` (36px) and the input row is `h-8` (32px, plain-text
// mode only); the body is whatever the user dragged to.
const HEADER_HEIGHT = 36;
const INPUT_HEIGHT = 32;

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

export default function OutputPanel({
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
}: OutputPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const [draft, setDraft] = useState("");
  // -1 means "editing a fresh line"; anything >= 0 indexes into inputHistory
  // from the end, which is the direction ↑ walks.
  const [historyPos, setHistoryPos] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

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
    termHandleRef.current?.focus();
  }, [draft, running, onSendInput, onRememberInput]);

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

  const flashCopied = useCallback(() => {
    setCopied(true);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
  }, []);

  /** True when the current document selection lives inside the output area. */
  const selectionInPanel = useCallback(() => {
    const el = scrollRef.current;
    const sel = document.getSelection();
    if (!el || !sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const node = sel.getRangeAt(0).commonAncestorContainer;
    return el.contains(node.nodeType === Node.TEXT_NODE ? node.parentNode : node);
  }, []);

  const copySelection = useCallback(async () => {
    const text = document.getSelection()?.toString() ?? "";
    if (await copyText(text)) flashCopied();
  }, [flashCopied]);

  const copyAll = useCallback(async () => {
    const text = output.map((l) => l.line).join("\n");
    if (await copyText(text)) flashCopied();
  }, [output, flashCopied]);

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
      // The stdin row only exists in plain-text mode, so its share of the
      // panel's height has to be given back to the body when it is hidden —
      // otherwise the panel keeps a gap that nothing can fill.
      style={{ height: height + HEADER_HEIGHT + (terminalMode ? 0 : INPUT_HEIGHT) }}
    >
      <VerticalResizeHandle onDrag={onResize} />
      <div className="h-9 flex items-center gap-2 px-3 border-b border-line-soft shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wide text-faint">{t("output.title")}</span>
        {running ? (
          <span className="text-xs text-accent flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            {t("output.running")}
          </span>
        ) : lastExit ? (
          lastExit.code === 0 ? (
            <span className="text-xs text-sub">{t("output.exited", { code: 0 })}</span>
          ) : (
            <span className="text-xs text-danger">{t("output.exited", { code: lastExit.code ?? "?" })}</span>
          )
        ) : null}
        <div className="flex-1" />
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
          onClick={copyAll}
          disabled={output.length === 0}
          title={t("output.copyAllTitle")}
          className="px-2 py-0.5 rounded text-xs text-sub hover:text-ink hover:bg-hover transition-colors disabled:opacity-40 disabled:text-faint disabled:hover:bg-transparent"
        >
          {copied ? t("output.copied") : t("output.copy")}
        </button>
        <button
          onClick={onClear}
          className="px-2 py-0.5 rounded text-xs text-sub hover:text-ink hover:bg-hover transition-colors"
        >
          {t("output.clear")}
        </button>
        {running && (
          <button
            onClick={onStop}
            className="px-2 py-0.5 rounded text-xs text-danger hover:bg-hover transition-colors"
          >
            {t("output.stop")}
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
      {/* Both renderers stay mounted; only visibility is toggled. Unmounting the
          terminal mid-run would throw away its scrollback, and unmounting the
          text view would reset its scroll position. */}
      <div
        className={`flex-1 min-h-0 select-text cursor-text ${terminalMode ? "" : "hidden"}`}
        style={{ padding: "4px 6px 0 10px" }}
      >
        <TerminalOutput
          onReady={handleTerminalReady}
          onData={handleTerminalData}
          onResize={onTerminalResize}
          fontSize={fontSize}
          fontFamily={fontFamily}
        />
      </div>
      <div
        ref={scrollRef}
        tabIndex={-1}
        onScroll={handleScroll}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        className={`output-text flex-1 overflow-auto px-3 py-2 font-mono text-xs leading-[1.5] select-text cursor-text outline-none ${
          terminalMode ? "hidden" : ""
        }`}
      >
        {output.length === 0 ? (
          <span className="text-faint">{t("output.none")}</span>
        ) : (
          output.map((l, i) => (
            <div
              key={i}
              className={
                (l.notice
                  ? "text-faint italic"
                  : l.stream === "stderr"
                    ? "text-danger"
                    : "text-sub") + " whitespace-pre-wrap break-all"
              }
            >
              {l.line}
            </div>
          ))
        )}
      </div>
      {/* stdin row. Only the plain-text mode needs it: a program reading from a
          pipe has no other way to receive a line, whereas the terminal takes
          keystrokes directly. Hidden (and its height reclaimed) in terminal
          mode so the panel is nothing but output. */}
      {!terminalMode && (
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
