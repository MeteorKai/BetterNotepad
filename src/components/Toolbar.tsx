import type { Theme } from "../hooks/useTheme";
import type { RecentFile } from "../hooks/useTabs";
import { t } from "../i18n";
import RecentFilesMenu from "./RecentFilesMenu";

interface ToolbarProps {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onSaveAll: () => void;
  hasUnsaved: boolean;
  onOpenFolder: () => void;
  onToggleExplorer: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSearch: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  wrap: boolean;
  onToggleWrap: () => void;
  recent: RecentFile[];
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
  modified: boolean;
  theme: Theme;
  onCycleTheme: () => void;
  mascotVisible: boolean;
  onToggleMascot: () => void;
  running: boolean;
  onRun: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
}

/** Literal keys, so the i18n coverage check can see them. */
function themeTitle(theme: Theme): string {
  if (theme === "light") return t("theme.light");
  if (theme === "dark") return t("theme.dark");
  return t("theme.warm");
}

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === "light") {
    return (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </>
    );
  }
  if (theme === "dark") {
    return <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />;
  }
  return (
    <>
      <path d="M17 18a5 5 0 0 0-10 0" />
      <line x1="12" y1="9" x2="12" y2="2" />
      <line x1="4.22" y1="10.22" x2="5.64" y2="11.64" />
      <line x1="1" y1="18" x2="3" y2="18" />
      <line x1="21" y1="18" x2="23" y2="18" />
      <line x1="18.36" y1="11.64" x2="19.78" y2="10.22" />
    </>
  );
}

function ToolButton({
  onClick,
  title,
  active,
  disabled,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      aria-pressed={active}
      className={`px-2.5 py-1.5 rounded-lg transition-colors duration-150 flex items-center justify-center focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
        disabled ? "opacity-40 cursor-default" : active ? "accent-chip" : "hover:bg-hover text-sub hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Separator() {
  return <div className="w-px h-5 bg-line-soft mx-1" />;
}

export default function Toolbar({
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  onSaveAll,
  hasUnsaved,
  onOpenFolder,
  onToggleExplorer,
  onUndo,
  onRedo,
  onSearch,
  onZoomIn,
  onZoomOut,
  wrap,
  onToggleWrap,
  recent,
  onOpenRecent,
  onClearRecent,
  theme,
  onCycleTheme,
  mascotVisible,
  onToggleMascot,
  running,
  onRun,
  onOpenSettings,
  onOpenAbout,
}: ToolbarProps) {
  return (
    <div className="app-toolbar relative h-12 flex items-center px-2 gap-0.5 border-b border-line-soft">
      <div className="relative flex items-center gap-0.5 flex-1 min-w-0">
        <div className="flex items-center gap-2 pl-1 pr-2 select-none">
          <div className="w-7 h-7 rounded-[10px] bg-accent-soft text-accent flex items-center justify-center shrink-0 border border-line-soft">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" y1="13" x2="16" y2="13" />
              <line x1="8" y1="17" x2="13" y2="17" />
            </svg>
          </div>
          <span className="text-sm font-semibold tracking-tight text-ink">BetterNotepad</span>
        </div>
        <Separator />
        {/* File operations */}
        <ToolButton onClick={onNew} title={t("toolbar.newTitle")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
        </ToolButton>
        <ToolButton onClick={onOpen} title={t("toolbar.openTitle")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </ToolButton>
        <ToolButton onClick={onSave} title={t("toolbar.saveTitle")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
        </ToolButton>
        <ToolButton onClick={onSaveAs} title={t("toolbar.saveAsTitle")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
            <path d="M12 11v6" />
            <path d="M9 14l3-3 3 3" />
          </svg>
        </ToolButton>
        <ToolButton onClick={onSaveAll} title={t("toolbar.saveAllTitle")} disabled={!hasUnsaved}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 19H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z" />
            <path d="M15 19V9H9v10" />
            <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8" />
          </svg>
        </ToolButton>
        <ToolButton onClick={onOpenFolder} title={t("toolbar.openFolderTitle")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </ToolButton>
        <ToolButton onClick={onToggleExplorer} title={t("toolbar.explorerTitle")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="3" x2="3" y2="21" />
            <rect x="7" y="3" width="14" height="18" rx="1" />
          </svg>
        </ToolButton>
        <RecentFilesMenu recent={recent} onOpen={onOpenRecent} onClear={onClearRecent} />

        <Separator />

        {/* Edit operations */}
        <ToolButton onClick={onUndo} title={t("toolbar.undoTitle")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </ToolButton>
        <ToolButton onClick={onRedo} title={t("toolbar.redoTitle")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
          </svg>
        </ToolButton>

        <Separator />

        {/* Run */}
        <ToolButton onClick={onRun} title={running ? t("toolbar.stopTitle") : t("toolbar.runTitle")}>
          {running ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="6 3 20 12 6 21 6 3" />
            </svg>
          )}
        </ToolButton>

        <Separator />

        <ToolButton onClick={onSearch} title={t("toolbar.findTitle")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </ToolButton>

        <Separator />

        {/* Zoom */}
        <ToolButton onClick={onZoomOut} title={t("toolbar.zoomOutTitle")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </ToolButton>
        <ToolButton onClick={onZoomIn} title={t("toolbar.zoomInTitle")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="11" y1="8" x2="11" y2="14" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </ToolButton>
        <ToolButton
          onClick={onToggleWrap}
          title={wrap ? t("toolbar.wrapOnTitle") : t("toolbar.wrapOffTitle")}
          active={wrap}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M4 19h6v-2H4v2zM20 5H4v2h16V5zm-3 6H4v2h13.25c1.1 0 2 .9 2 2s-.9 2-2 2H15v-2l-3 3 3 3v-2h2c2.21 0 4-1.79 4-4s-1.79-4-4-4z" />
          </svg>
        </ToolButton>
      </div>

      {/* About */}
      <button
        onClick={onOpenAbout}
        title={t("toolbar.aboutTitle")}
        aria-label={t("toolbar.aboutTitle")}
        className="relative flex items-center justify-center w-8 h-8 rounded-lg text-sub hover:bg-hover hover:text-ink transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      </button>

      {/* Settings */}
      <button
        onClick={onOpenSettings}
        title={t("toolbar.settingsTitle")}
        aria-label={t("toolbar.settingsAria")}
        className="relative flex items-center justify-center w-8 h-8 rounded-lg text-sub hover:bg-hover hover:text-ink transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {/* Mascot toggle */}
      <button
        onClick={onToggleMascot}
        title={mascotVisible ? t("toolbar.mascotHideTitle") : t("toolbar.mascotShowTitle")}
        aria-label={t("toolbar.mascotAria")}
        aria-pressed={mascotVisible}
        className={`relative flex items-center justify-center w-8 h-8 rounded-lg transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
          mascotVisible ? "accent-chip" : "text-sub hover:bg-hover hover:text-ink"
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3a7 7 0 0 0-7 7v9l2.2-1.8 2.4 1.8 2.4-1.8 2.4 1.8 2.4-1.8L19 19v-9a7 7 0 0 0-7-7z" />
          <circle cx="9" cy="10" r="1.3" />
          <circle cx="15" cy="10" r="1.3" />
        </svg>
      </button>

      {/* Theme switcher */}
      <button
        onClick={onCycleTheme}
        title={t("toolbar.themeSwitch", { theme: themeTitle(theme) })}
        aria-label={t("toolbar.themeAria")}
        className="relative flex items-center justify-center w-8 h-8 rounded-lg accent-chip focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <ThemeIcon theme={theme} />
        </svg>
      </button>
    </div>
  );
}
