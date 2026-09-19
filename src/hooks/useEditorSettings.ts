import { useCallback, useEffect, useState } from "react";
import type { LocaleSetting } from "../i18n";

export type Eol = "lf" | "crlf";

/** Where run programmes get their working directory from. */
export type RunCwdMode = "folder" | "script" | "custom";

export interface EditorSettings {
  tabWidth: number;
  insertSpaces: boolean;
  defaultEol: Eol;
  fontFamily: string;
  fontSize: number;
  runCwdMode: RunCwdMode;
  runCwdCustom: string;
  /** UI language: an explicit locale, or follow the operating system. */
  locale: LocaleSetting;
  /**
   * Register the Explorer "Edit with BetterNotepad" context-menu entry.
   * Defaults to on, so the entry appears without the user hunting for it.
   */
  contextMenu: boolean;
}

export const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "Default (monospace)", value: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace' },
  { label: "Consolas", value: 'Consolas, "Courier New", monospace' },
  { label: "Cascadia Code", value: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
  { label: "JetBrains Mono", value: '"JetBrains Mono", Consolas, monospace' },
  { label: "Fira Code", value: '"Fira Code", Consolas, monospace' },
  { label: "Source Code Pro", value: '"Source Code Pro", Consolas, monospace' },
  { label: "Courier New", value: '"Courier New", monospace' },
  { label: "Microsoft YaHei (微软雅黑)", value: '"Microsoft YaHei", "PingFang SC", sans-serif' },
];

const STORAGE_KEY = "betternotepad.editor";

const DEFAULTS: EditorSettings = {
  tabWidth: 2,
  insertSpaces: false,
  defaultEol: "lf",
  fontFamily: FONT_OPTIONS[0].value,
  fontSize: 14,
  runCwdMode: "folder",
  runCwdCustom: "",
  locale: "system",
  contextMenu: true,
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function loadSettings(): EditorSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<EditorSettings>;
    return {
      tabWidth: clampInt(p.tabWidth, 1, 8, DEFAULTS.tabWidth),
      insertSpaces: typeof p.insertSpaces === "boolean" ? p.insertSpaces : DEFAULTS.insertSpaces,
      defaultEol: p.defaultEol === "crlf" ? "crlf" : "lf",
      fontFamily:
        typeof p.fontFamily === "string" && p.fontFamily.length > 0 ? p.fontFamily : DEFAULTS.fontFamily,
      fontSize: clampInt(p.fontSize, 8, 32, DEFAULTS.fontSize),
      runCwdMode:
        p.runCwdMode === "script" || p.runCwdMode === "custom" || p.runCwdMode === "folder"
          ? p.runCwdMode
          : DEFAULTS.runCwdMode,
      runCwdCustom: typeof p.runCwdCustom === "string" ? p.runCwdCustom : DEFAULTS.runCwdCustom,
      locale: p.locale === "zh" || p.locale === "en" ? p.locale : DEFAULTS.locale,
      // Stored settings written before this option existed fall back to the
      // default, which is how the entry gets created for existing installs.
      contextMenu:
        typeof p.contextMenu === "boolean" ? p.contextMenu : DEFAULTS.contextMenu,
    };
  } catch {
    return DEFAULTS;
  }
}

export function useEditorSettings() {
  const [settings, setSettings] = useState<EditorSettings>(loadSettings);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // ignore quota / privacy-mode errors
    }
  }, [settings]);

  const patch = useCallback(
    (p: Partial<EditorSettings> | ((prev: EditorSettings) => Partial<EditorSettings>)) => {
      setSettings((s) => ({ ...s, ...(typeof p === "function" ? p(s) : p) }));
    },
    []
  );

  return { settings, patch };
}
