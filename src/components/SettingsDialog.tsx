import { useEffect, useRef, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { InterpreterConfig } from "../hooks/useRunner";
import { t, type LocaleSetting } from "../i18n";
import {
  FONT_OPTIONS,
  type EditorSettings,
  type RunCwdMode,
} from "../hooks/useEditorSettings";

interface SettingsDialogProps {
  config: InterpreterConfig[];
  onSet: (language: string, patch: Partial<InterpreterConfig>) => void;
  onApplyDetected: () => void;
  editorSettings: EditorSettings;
  onSetEditor: (
    patch: Partial<EditorSettings> | ((prev: EditorSettings) => Partial<EditorSettings>)
  ) => void;
  onClose: () => void;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-line overflow-hidden">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={
            value === o.value
              ? "px-3 py-1 text-xs font-medium accent-chip"
              : "px-3 py-1 text-xs text-sub hover:text-ink hover:bg-hover transition-colors"
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-sub shrink-0">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

/** Small on/off switch — an on/off registry setting reads better as a switch
 *  than as a checkbox sitting among the interpreter rows. */
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      className={
        "relative w-9 h-5 shrink-0 rounded-full border transition-colors " +
        (checked ? "bg-accent border-accent" : "bg-surface border-line hover:border-faint")
      }
    >
      <span
        className={
          "absolute top-[3px] h-3.5 w-3.5 rounded-full transition-all " +
          (checked ? "left-[19px] bg-accent-ink" : "left-[3px] bg-faint")
        }
      />
    </button>
  );
}

function EditorSettingsPanel({
  settings,
  onSet,
}: {
  settings: EditorSettings;
  onSet: (patch: Partial<EditorSettings>) => void;
}) {
  const browseCwd = async () => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === "string") onSet({ runCwdCustom: selected });
    } catch (err) {
      console.error("Failed to browse for run directory:", err);
    }
  };

  return (
    <div className="space-y-4">
      <Row label={t("settings.tabWidth")}>
        <input
          type="number"
          min={1}
          max={8}
          value={settings.tabWidth}
          onChange={(e) =>
            onSet({ tabWidth: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })
          }
          className="w-20 bg-surface text-ink px-2 py-1 rounded-md border border-line outline-none focus:border-accent text-sm transition-colors"
        />
      </Row>
      <Row label={t("settings.insert")}>
        <Segmented<"spaces" | "tab">
          value={settings.insertSpaces ? "spaces" : "tab"}
          options={[
            { value: "spaces", label: t("settings.insert.spaces") },
            { value: "tab", label: t("settings.insert.tab") },
          ]}
          onChange={(v) => onSet({ insertSpaces: v === "spaces" })}
        />
      </Row>
      <Row label={t("settings.defaultEol")}>
        <Segmented<"lf" | "crlf">
          value={settings.defaultEol}
          options={[
            { value: "lf", label: "LF" },
            { value: "crlf", label: "CRLF" },
          ]}
          onChange={(v) => onSet({ defaultEol: v })}
        />
      </Row>
      <Row label={t("settings.font")}>
        <select
          value={settings.fontFamily}
          onChange={(e) => onSet({ fontFamily: e.target.value })}
          className="min-w-[220px] bg-surface text-ink px-2 py-1 rounded-md border border-line outline-none focus:border-accent text-sm transition-colors"
        >
          {FONT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t("settings.fontSize")}>
        <input
          type="number"
          min={8}
          max={32}
          value={settings.fontSize}
          onChange={(e) =>
            onSet({ fontSize: Math.min(32, Math.max(8, Number(e.target.value) || 8)) })
          }
          className="w-20 bg-surface text-ink px-2 py-1 rounded-md border border-line outline-none focus:border-accent text-sm transition-colors"
        />
      </Row>

      <div className="pt-3 border-t border-line-soft space-y-3">
        <Row label={t("settings.runIn")}>
          <Segmented<RunCwdMode>
            value={settings.runCwdMode}
            options={[
              { value: "folder", label: t("settings.runIn.folder") },
              { value: "script", label: t("settings.runIn.script") },
              { value: "custom", label: t("settings.runIn.custom") },
            ]}
            onChange={(v) => onSet({ runCwdMode: v })}
          />
        </Row>
        {settings.runCwdMode === "custom" && (
          <div className="flex items-center gap-2">
            <input
              value={settings.runCwdCustom}
              onChange={(e) => onSet({ runCwdCustom: e.target.value })}
              placeholder={t("settings.runIn.customPlaceholder")}
              className="flex-1 min-w-0 bg-surface text-ink px-2 py-1 rounded-md border border-line outline-none focus:border-accent text-sm transition-colors"
            />
            <button
              onClick={browseCwd}
              title={t("settings.runIn.browse")}
              className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-faint hover:text-ink hover:bg-hover transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          </div>
        )}
        <p className="text-[11px] text-faint leading-relaxed">
          {t("settings.runIn.hintLead")}
          <code className="font-mono">open(&quot;data.txt&quot;)</code>
          {t("settings.runIn.hintTail")}
        </p>
      </div>
    </div>
  );
}

const RELEASES_URL = "https://github.com/MeteorKai/BetterNotepad/releases";

function AboutPanel({
  locale,
  onSetLocale,
  contextMenu,
  onSetContextMenu,
}: {
  locale: LocaleSetting;
  onSetLocale: (locale: LocaleSetting) => void;
  contextMenu: boolean;
  onSetContextMenu: (enabled: boolean) => void;
}) {
  const [version, setVersion] = useState("");

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    getVersion().then(setVersion).catch(() => {});
  }, []);

  // There is no in-app updater any more: "check for updates" just hands the
  // user off to the project's GitHub page, where every release and its notes
  // live. Same pattern as the homepage button in AboutDialog.
  const openReleases = () => {
    if ("__TAURI_INTERNALS__" in window) {
      openUrl(RELEASES_URL).catch(() => {});
    } else {
      window.open(RELEASES_URL, "_blank", "noreferrer");
    }
  };

  return (
    <div className="space-y-4">
      <Row label={t("settings.language")}>
        <select
          value={locale}
          onChange={(e) => onSetLocale(e.target.value as LocaleSetting)}
          className="min-w-[150px] bg-surface text-ink px-2 py-1 rounded-md border border-line outline-none focus:border-accent text-sm transition-colors"
        >
          <option value="system">{t("settings.language.system")}</option>
          <option value="zh">{t("settings.language.zh")}</option>
          <option value="en">{t("settings.language.en")}</option>
        </select>
      </Row>

      <div className="space-y-1.5">
        <Row label={t("settings.contextMenu")}>
          <Toggle
            checked={contextMenu}
            onChange={onSetContextMenu}
            label={t("settings.contextMenu")}
          />
        </Row>
        <p className="text-[11px] text-faint leading-relaxed">
          {t("settings.contextMenu.hint")}
        </p>
      </div>

      <Row label={t("about.version")}>
        <span className="font-mono text-sm text-ink select-text cursor-text">
          {version || t("about.unknownVersion")}
        </span>
      </Row>
      <div className="space-y-1.5">
        <Row label={t("about.updates")}>
          <button
            onClick={openReleases}
            className="px-3 py-1 rounded-md text-xs font-medium text-accent-ink bg-accent hover:bg-accent-strong transition-colors"
          >
            {t("about.check")}
          </button>
        </Row>
        <p className="text-[11px] text-faint leading-relaxed">{t("about.checkHint")}</p>
      </div>
    </div>
  );
}

export default function SettingsDialog({
  config,
  onSet,
  onApplyDetected,
  editorSettings,
  onSetEditor,
  onClose,
}: SettingsDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<"editor" | "interpreters" | "about">("editor");

  const browse = async (language: string) => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    try {
      const selected = await open({
        multiple: false,
        filters: [
          { name: t("dialog.executable"), extensions: ["exe", "bat", "cmd"] },
          { name: t("dialog.allFiles"), extensions: ["*"] },
        ],
      });
      if (selected && typeof selected === "string") {
        onSet(language, { command: selected });
      }
    } catch (err) {
      console.error("Failed to browse for executable:", err);
    }
  };

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="relative overflow-hidden bg-elevated border border-line rounded-2xl shadow-2xl w-[560px] max-h-[80vh] flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="pointer-events-none absolute inset-0 pattern-dots" />
        <div className="glow-orb w-56 h-32 -top-20 -left-20" />

        <div className="relative flex items-center gap-3 px-6 pt-5 pb-3 border-b border-line-soft">
          <div className="flex rounded-lg border border-line overflow-hidden">
            <button
              onClick={() => setTab("editor")}
              className={
                tab === "editor"
                  ? "px-3 py-1 text-sm font-medium accent-chip"
                  : "px-3 py-1 text-sm text-sub hover:text-ink hover:bg-hover transition-colors"
              }
            >
              {t("settings.tab.editor")}
            </button>
            <button
              onClick={() => setTab("interpreters")}
              className={
                tab === "interpreters"
                  ? "px-3 py-1 text-sm font-medium accent-chip"
                  : "px-3 py-1 text-sm text-sub hover:text-ink hover:bg-hover transition-colors"
              }
            >
              {t("settings.tab.interpreters")}
            </button>
            <button
              onClick={() => setTab("about")}
              className={
                tab === "about"
                  ? "px-3 py-1 text-sm font-medium accent-chip"
                  : "px-3 py-1 text-sm text-sub hover:text-ink hover:bg-hover transition-colors"
              }
            >
              {t("settings.tab.general")}
            </button>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            className="ml-auto w-6 h-6 rounded-md flex items-center justify-center text-faint hover:text-ink hover:bg-hover transition-colors"
            title={t("common.closeEsc")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="relative flex-1 overflow-y-auto px-6 py-4">
          {tab === "editor" ? (
            <EditorSettingsPanel
              settings={editorSettings}
              onSet={(patch) => onSetEditor(patch)}
            />
          ) : tab === "about" ? (
            <AboutPanel
              locale={editorSettings.locale}
              onSetLocale={(locale) => onSetEditor({ locale })}
              contextMenu={editorSettings.contextMenu}
              onSetContextMenu={(contextMenu) => onSetEditor({ contextMenu })}
            />
          ) : (
            <>
              <p className="text-xs text-faint mb-3 leading-relaxed">
                {t("settings.interpreters.hint")}
              </p>
              {config.length === 0 && (
                <p className="text-sm text-sub mb-2">{t("settings.interpreters.empty")}</p>
              )}
              <div className="space-y-2">
                {config.map((c) => (
                  <div key={c.language} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={(e) => onSet(c.language, { enabled: e.target.checked })}
                      className="accent-[var(--accent)] h-4 w-4 shrink-0"
                      title={t("settings.interpreters.enable", { language: c.language })}
                    />
                    <span className="w-16 shrink-0 text-sm text-ink">{c.language}</span>
                    <input
                      value={c.command}
                      onChange={(e) => onSet(c.language, { command: e.target.value })}
                      placeholder={t("settings.interpreters.command")}
                      className="flex-1 min-w-0 bg-surface text-ink px-2 py-1 rounded-md border border-line outline-none focus:border-accent text-sm transition-colors"
                    />
                    <button
                      onClick={() => browse(c.language)}
                      title={t("settings.interpreters.browse")}
                      className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-faint hover:text-ink hover:bg-hover transition-colors"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="12" y1="18" x2="12" y2="12" />
                        <line x1="9" y1="15" x2="15" y2="15" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="relative flex justify-end gap-2 px-6 pb-5 pt-3 border-t border-line-soft">
          {tab === "interpreters" && (
            <button
              onClick={onApplyDetected}
              className="px-3 py-1.5 rounded-md text-sm text-sub hover:text-ink hover:bg-hover transition-colors"
            >
              {t("settings.detect")}
            </button>
          )}
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-accent-ink bg-accent hover:bg-accent-strong transition-colors"
          >
            {t("settings.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
