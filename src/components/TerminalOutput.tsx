import { useEffect, useLayoutEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SerializeAddon } from "@xterm/addon-serialize";
import "@xterm/xterm/css/xterm.css";
import { copyText } from "../utils/clipboard";

/**
 * Reads the app's CSS custom properties and maps them onto xterm's palette.
 *
 * Going through the variables rather than hardcoding colours is what keeps the
 * terminal in step with the three themes (`dark` / `light` / `warm`) — the same
 * rule the rest of the UI follows. Called on mount and again whenever the theme
 * attribute changes.
 */
function readTheme(el: HTMLElement) {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;

  const bg = v("--editor-bg", "#1a1a20");
  const fg = v("--ink", "#e4e4ea");
  const selection = v("--selection", "rgba(169, 159, 240, 0.28)");
  const caret = v("--caret", "#e4e4ea");

  return {
    background: bg,
    foreground: fg,
    cursor: caret,
    cursorAccent: bg,
    selectionBackground: selection,
    // The 16 ANSI slots, approximated from the token palette. Programs emit
    // these indices (SGR 30-37 / 90-97), so they matter more than they look:
    // without them a "coloured" program renders monochrome.
    black: v("--gutter-text", "#5f5f6b"),
    red: v("--danger", "#f38ba8"),
    green: v("--tok-selector", "#9ed3a8"),
    yellow: v("--tok-class", "#e3c98a"),
    blue: v("--tok-function", "#8fb4f5"),
    magenta: v("--tok-regex", "#ee8fae"),
    cyan: v("--tok-operator", "#86cdc6"),
    white: v("--sub", "#9898a5"),
    brightBlack: v("--faint", "#63636f"),
    brightRed: v("--danger", "#f38ba8"),
    brightGreen: v("--tok-selector", "#9ed3a8"),
    brightYellow: v("--tok-boolean", "#eab07f"),
    brightMagenta: v("--accent-strong", "#b9b0f6"),
    brightCyan: v("--tok-operator", "#86cdc6"),
    brightBlue: v("--tok-function", "#8fb4f5"),
    brightWhite: v("--ink", "#e4e4ea"),
  };
}

export interface TerminalOutputProps {
  /** Whether this terminal has a laid-out, interactive viewport. */
  visible: boolean;
  /** Registered once the terminal exists. `null` on unmount. */
  onReady: (api: TerminalHandle | null) => void;
  /** Raw terminal bytes produced by a keystroke or paste. */
  onData: (data: string) => void;
  /** Fired after a fit, so the PTY can be resized to match. */
  onResize: (cols: number, rows: number) => void;
  fontSize: number;
  fontFamily: string;
}

export interface TerminalHandle {
  write: (data: Uint8Array) => void;
  clear: () => void;
  focus: () => void;
  /** Re-measure and push the new size through `onResize`. */
  refit: () => void;
  /** Serialised scrollback, for handing the session to a fresh instance. */
  snapshot: () => string;
}

/**
 * Keys the terminal must own rather than let bubble to the window.
 *
 * The app binds most single-key shortcuts on `window` — typing `c` in the
 * editor is fine because CodeMirror stops propagation, but a terminal is not
 * an input element, so without this a program would never see the letters.
 * Only the *plain* forms are swallowed; `Ctrl`/`Alt` combinations keep
 * working, which is what leaves `Ctrl+C` free to mean "copy the selection when
 * there is one, otherwise SIGINT" (see the copy branch below).
 */
const CAPTURED_PLAIN_KEYS = new Set([
  " ",
  "Backspace",
  "Delete",
  "Enter",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Tab",
  "Escape",
]);

/**
 * xterm.js host for the "real terminal" output mode.
 *
 * Kept deliberately thin: it owns an xterm instance and forwards bytes both
 * ways. Session lifecycle (open/write/resize/close) lives in `useRunner`, so
 * this component can be unmounted and remounted without the PTY noticing as
 * long as the parent restores the scrollback.
 */
export default function TerminalOutput({
  visible,
  onReady,
  onData,
  onResize,
  fontSize,
  fontFamily,
}: TerminalOutputProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Font size as reported by the latest render, readable from the mount effect
  // without adding it to that effect's dependencies.
  const fontSizeRef = useRef({ fontSize, fontFamily });

  // Latest callbacks, read through refs so the terminal is created exactly once
  // rather than being torn down whenever a parent re-render produces a new
  // closure.
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const onReadyRef = useRef(onReady);
  onDataRef.current = onData;
  onResizeRef.current = onResize;
  onReadyRef.current = onReady;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: fontSizeRef.current.fontFamily,
      fontSize: fontSizeRef.current.fontSize,
      lineHeight: 1.3,
      // Deep enough that a chatty run keeps its early output reachable, but
      // still a cap — one the panel can point past, since the backend writes
      // every run's complete output to a log file. Kept in step with the text
      // view's MAX_OUTPUT_LINES so switching views does not change how much
      // history survives.
      scrollback: 20000,
      allowProposedApi: true,
      theme: readTheme(host),
    });

    const fit = new FitAddon();
    const serializer = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(serializer);
    term.loadAddon(new WebLinksAddon());
    // `attachCustomKeyEventHandler` is only available once an addon has been
    // registered — it lives on the addon manager, which `open()` creates.
    term.open(host);

    // WebGL is much faster for the burst of output a build script produces, but
    // it depends on a working GPU driver — fall back to the canvas renderer
    // rather than showing a blank panel.
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* canvas renderer stays active */
    }

    termRef.current = term;
    fitRef.current = fit;

    const fitVisible = () => {
      if (!visibleRef.current || host.clientWidth <= 0 || host.clientHeight <= 0) return;
      try {
        fit.fit();
        onResizeRef.current(term.cols, term.rows);
      } catch {
        /* host not laid out yet */
      }
    };

    const disposable = term.onData((data) => onDataRef.current(data));

    // Ctrl/Cmd + `+` / `-` / `0` is handled by the app's window-level zoom
    // shortcut. Returning false keeps xterm from sending those keys to the PTY.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (!(e.ctrlKey || e.metaKey)) return true;

      // Copy the terminal's own selection. xterm paints into a canvas, so there
      // is no DOM selection for the browser — or for the panel's own Ctrl+C
      // handler — to reach. With nothing selected the key must keep reaching the
      // program as SIGINT (^C), hence the `hasSelection()` test instead of
      // binding the chord outright. Returning false keeps xterm from encoding
      // `\x03`, exactly as the zoom branch below does.
      if (e.key.toLowerCase() === "c" && !e.altKey && !e.getModifierState("AltGraph") && term.hasSelection()) {
        e.preventDefault();
        e.stopPropagation();
        void copyText(term.getSelection());
        return false;
      }

      if (e.altKey || e.getModifierState("AltGraph")) return true;
      if (e.key !== "+" && e.key !== "=" && e.key !== "-" && e.key !== "0") return true;
      e.preventDefault();
      return false;
    });

    // Swallow plain keystrokes so the window-level shortcut handler does not
    // treat typing in the terminal as a command. Attached to the host element
    // during the bubble phase, i.e. after xterm has already encoded the key.
    const swallowKeys = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (e.key.length === 1 || CAPTURED_PLAIN_KEYS.has(key)) {
        e.stopPropagation();
      }
    };
    host.addEventListener("keydown", swallowKeys);
    host.addEventListener("keyup", swallowKeys);
    // Every mouse click inside the terminal should move focus to it, including
    // the blank area to the right of the last column.
    const focusOnClick = () => term.focus();
    host.addEventListener("mouseup", focusOnClick);

    // First fit has to wait for layout; the panel is often still 0-height on
    // the very first effect pass.
    const initial = requestAnimationFrame(fitVisible);

    onReadyRef.current({
      write: (data) => term.write(data),
      clear: () => term.clear(),
      focus: () => term.focus(),
      snapshot: () => {
        try {
          return serializer.serialize();
        } catch {
          return "";
        }
      },
      refit: () => {
        fitVisible();
      },
    });

    // Re-fit on container resize. `ResizeObserver` covers the drag handle and
    // the sidebar toggle without the parent having to forward events.
    const ro = new ResizeObserver(fitVisible);
    ro.observe(host);

    // Follow theme switches. The app writes `data-theme` on <html>, so watch
    // that attribute rather than guessing at a re-render.
    const mo = new MutationObserver(() => {
      term.options.theme = readTheme(host);
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });

    return () => {
      cancelAnimationFrame(initial);
      ro.disconnect();
      mo.disconnect();
      host.removeEventListener("keydown", swallowKeys);
      host.removeEventListener("keyup", swallowKeys);
      host.removeEventListener("mouseup", focusOnClick);
      disposable.dispose();
      onReadyRef.current(null);
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
    // Font settings are applied by the effect below; recreating the terminal
    // here would drop the scrollback and the PTY's idea of the viewport size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A hidden panel stays mounted to retain output, but has no geometry to fit.
  // Refit once it is visible again so both xterm and the PTY use the real size.
  useLayoutEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      const host = hostRef.current;
      const term = termRef.current;
      if (!host || !term || host.clientWidth <= 0 || host.clientHeight <= 0) return;
      try {
        fitRef.current?.fit();
        term.refresh(0, Math.max(0, term.rows - 1));
        onResizeRef.current(term.cols, term.rows);
      } catch {
        /* host not laid out yet */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [visible]);

  // Font changes are a live option update, not a rebuild.
  useLayoutEffect(() => {
    fontSizeRef.current = { fontSize, fontFamily };
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    const host = hostRef.current;
    if (!visibleRef.current || !host || host.clientWidth <= 0 || host.clientHeight <= 0) return;
    try {
      fitRef.current?.fit();
      onResizeRef.current(term.cols, term.rows);
    } catch {
      /* ignore */
    }
  }, [fontSize, fontFamily]);

  return <div ref={hostRef} data-terminal-output="" tabIndex={-1} className="w-full h-full outline-none" />;
}
