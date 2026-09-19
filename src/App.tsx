import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Toolbar from "./components/Toolbar";
import Editor, {
  clearEditorHistory,
  exceedsLineThreshold,
  LARGE_FILE_LINE_THRESHOLD,
  type EditorHandle,
} from "./components/Editor";
import StatusBar from "./components/StatusBar";
import TabBar from "./components/TabBar";
import SearchBar from "./components/SearchBar";
import ConfirmCloseDialog from "./components/ConfirmCloseDialog";
import ConfirmAppCloseDialog from "./components/ConfirmAppCloseDialog";
import FileExplorer from "./components/FileExplorer";
import Mascot from "./components/Mascot";
import OutputPanel from "./components/OutputPanel";
import SettingsDialog from "./components/SettingsDialog";
import AboutDialog from "./components/AboutDialog";
import GlobalSearchPanel from "./components/GlobalSearchPanel";
import MarkdownPreview from "./components/MarkdownPreview";
import ResizeHandle from "./components/ResizeHandle";
import { useTabs, type Tab } from "./hooks/useTabs";
import { useFileExplorer, type FileNode } from "./hooks/useFileExplorer";
import { useEditorState } from "./hooks/useEditorState";
import { useTheme } from "./hooks/useTheme";
import { useEditorSettings } from "./hooks/useEditorSettings";
import { useMascot } from "./hooks/useMascot";
import { useRunner } from "./hooks/useRunner";
import { useUpdater } from "./hooks/useUpdater";
import { getI18nLocale, resolveLocale, setI18nLocale, t } from "./i18n";

const LANGUAGE_BY_EXT: Record<string, string> = {
  py: "python",
  php: "php",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  css: "css",
  scss: "scss",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  sql: "sql",
  rb: "ruby",
  swift: "swift",
  kt: "kotlin",
  cs: "csharp",
  ini: "ini",
  diff: "diff",
};

function detectLanguage(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? null;
}

const RUN_LANG_BY_EXT: Record<string, string> = {
  py: "python",
  php: "php",
  js: "node",
  mjs: "node",
  cjs: "node",
  rb: "ruby",
  go: "go",
  sh: "bash",
  bash: "bash",
  pl: "perl",
  lua: "lua",
};

function detectRunLanguage(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1) return null;
  return RUN_LANG_BY_EXT[fileName.slice(dot + 1).toLowerCase()] ?? null;
}

/** Directory part of a path, without pulling in a path utility. */
function dirName(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx <= 0 ? "" : p.slice(0, idx);
}

function App() {
  const { settings: editorSettings, patch: setEditorSettings } = useEditorSettings();

  // Sync the i18n layer before children render, so `t()` is already correct on
  // this pass and a language change needs no extra effect or re-render.
  setI18nLocale(resolveLocale(editorSettings.locale));

  const {
    tabs,
    activeTabId,
    activeTab,
    unsavedTabs,
    activateTab,
    moveTab,
    setActiveContent,
    renameTab,
    setTabEncoding,
    newTab,
    openTab,
    openPaths,
    openFiles,
    recentFiles,
    clearRecent,
    saveActive,
    saveActiveAs,
    saveAll,
    saveTabData,
    persistSessionNow,
    discardUnsavedFromSession,
    requestClose,
    closeTab,
    renameOpenFile,
    closeOpenFile,
    pendingClose,
    cancelPendingClose,
    confirmPendingClose,
  } = useTabs({ defaultEol: editorSettings.defaultEol });

  const {
    cursorLine,
    cursorCol,
    totalLines,
    updateCursor,
  } = useEditorState(activeTab.content);

  const explorer = useFileExplorer();

  const { theme, cycle: cycleTheme } = useTheme();
  const mascot = useMascot();
  const runner = useRunner();
  const updater = useUpdater();

  // The Windows updater installer quits the app before installing, so flush the
  // session first — it keeps unsaved buffers, and those come back on restart.
  const installUpdate = useCallback(() => {
    updater.install(persistSessionNow).catch(() => {});
  }, [updater.install, persistSessionNow]);

  const [outputOpen, setOutputOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [selectionLen, setSelectionLen] = useState(0);

  const [typingTick, setTypingTick] = useState(0);
  useEffect(() => {
    setTypingTick((t) => t + 1);
  }, [activeTab.content]);

  // Startup update check. Delayed so it never races with restoring the session,
  // and silent so a failure (offline, GitHub down) stays out of the user's way —
  // a real update shows up as a dot on the About tab in Settings.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const timer = window.setTimeout(() => {
      void updater.checkNow(true);
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [updater.checkNow]);

  const firstTabIdRef = useRef(activeTab.id);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Files handed to us by the OS.
  //
  // Cold start: Windows "Open with" puts the path on our command line. Warm
  // start: the app is already running, so the extra process is swallowed by the
  // single-instance plugin and its command line is forwarded as `open-files`.
  // Either way the file becomes a tab in this window — no second copy of the app.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const openIncoming = async (paths: string[]) => {
      if (!paths.length) return;
      // Tabs are de-duped by path, so re-opening an already-open file just
      // focuses its tab rather than loading a second copy.
      await openPaths(paths);
      // The initial blank tab has served its purpose once a real file is open.
      const first = tabsRef.current.find((t) => t.id === firstTabIdRef.current);
      if (first && first.content === "" && first.filePath === null) {
        closeTab(first.id);
      }
    };

    (async () => {
      // Subscribe before draining: anything forwarded from here on arrives as an
      // event, and a path delivered both ways is harmless (see `openIncoming`).
      try {
        const fn = await listen<string[]>("open-files", (event) => {
          if (!cancelled) void openIncoming(event.payload);
        });
        if (cancelled) fn();
        else unlisten = fn;
      } catch (err) {
        console.error("Failed to listen for forwarded files:", err);
      }

      try {
        const [startup, pending] = await Promise.all([
          invoke<string[]>("get_startup_files"),
          invoke<string[]>("take_pending_open_files"),
        ]);
        if (cancelled) return;
        await openIncoming([...new Set([...startup, ...pending])]);
      } catch (err) {
        console.error("Failed to open file passed to app:", err);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openPaths, closeTab]);

  // Keep the Explorer "Edit with BetterNotepad" context-menu entry in step with
  // the setting.
  //
  // Doing this on every start rather than only when the toggle flips is
  // deliberate: it repairs the recorded executable path if the app has moved,
  // and rewrites the menu wording after a language change. Turning the toggle
  // off removes the registry key, so nothing is left behind.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    invoke("set_context_menu", {
      enabled: editorSettings.contextMenu,
      label: t("shell.editWith"),
    }).catch((err) => console.error("Failed to update the Explorer context menu entry:", err));
  }, [editorSettings.contextMenu, getI18nLocale()]);

  // Keep the native window title in sync with the active tab.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const marker = activeTab.modified ? "* " : "";
    getCurrentWindow()
      .setTitle(`${marker}${activeTab.fileName} - BetterNotepad`)
      .catch(() => {});
  }, [activeTab.fileName, activeTab.modified]);

  // Drop undo history for tabs that have been closed (Editor keeps per-tab
  // history in a module-level map so switching tabs preserves undo/redo).
  const tabIdsRef = useRef(new Set<string>());
  useEffect(() => {
    const current = new Set(tabs.map((t) => t.id));
    const prev = tabIdsRef.current;
    for (const id of prev) if (!current.has(id)) clearEditorHistory(id);
    tabIdsRef.current = current;
  }, [tabs]);

  const handleRenameNode = useCallback(
    async (node: FileNode, newName: string) => {
      const newPath = await explorer.renameNode(node, newName);
      if (newPath) renameOpenFile(node.path, newPath, newName);
    },
    [explorer, renameOpenFile]
  );

  const handleDeleteNode = useCallback(
    async (node: FileNode) => {
      const ok = await explorer.deleteNode(node);
      if (ok) closeOpenFile(node.path);
    },
    [explorer, closeOpenFile]
  );

  const [showSearch, setShowSearch] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const isMarkdown = detectLanguage(activeTab.fileName) === "markdown";
  const activeLargeFile = useMemo(
    () => exceedsLineThreshold(activeTab.content, LARGE_FILE_LINE_THRESHOLD),
    [activeTab.content]
  );
  const revealLineRef = useRef<{ path: string; line: number } | null>(null);

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const n = Number(localStorage.getItem("betternotepad.sidebarWidth"));
    return Number.isFinite(n) && n > 0 ? n : 240;
  });
  useEffect(() => {
    try {
      localStorage.setItem("betternotepad.sidebarWidth", String(sidebarWidth));
    } catch {
      // ignore
    }
  }, [sidebarWidth]);

  const [editorRatio, setEditorRatio] = useState<number>(() => {
    const n = Number(localStorage.getItem("betternotepad.editorRatio"));
    return Number.isFinite(n) && n > 0.1 && n < 0.9 ? n : 0.5;
  });
  useEffect(() => {
    try {
      localStorage.setItem("betternotepad.editorRatio", String(editorRatio));
    } catch {
      // ignore
    }
  }, [editorRatio]);

  const splitRef = useRef<HTMLDivElement>(null);
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const handleSidebarDrag = useCallback((delta: number) => {
    setSidebarWidth((w) => clamp(w + delta, 160, 600));
  }, []);
  const handleSplitDrag = useCallback((delta: number) => {
    const w = splitRef.current?.clientWidth || 800;
    setEditorRatio((r) => clamp(r + delta / w, 0.2, 0.8));
  }, []);
  const [wrap, setWrap] = useState<boolean>(() => {
    try {
      return localStorage.getItem("betternotepad.wrap") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("betternotepad.wrap", wrap ? "1" : "0");
    } catch {
      // ignore
    }
  }, [wrap]);
  const toggleWrap = useCallback(() => setWrap((w) => !w), []);
  useEffect(() => {
    if (!isMarkdown) setPreviewOpen(false);
  }, [isMarkdown]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [appClosingTabs, setAppClosingTabs] = useState<Tab[] | null>(null);
  const editorRef = useRef<EditorHandle>(null);

  const closeSearch = useCallback(() => {
    editorRef.current?.clearSearch();
    editorRef.current?.focusEditor();
    setShowSearch(false);
  }, []);

  const openSearch = useCallback((replace: boolean) => {
    setShowReplace(replace);
    setShowSearch(true);
  }, []);

  const toggleSearch = useCallback(() => {
    if (showSearch) closeSearch();
    else openSearch(false);
  }, [showSearch, closeSearch, openSearch]);

  const cycleTabs = useCallback(
    (dir: 1 | -1) => {
      if (tabs.length <= 1) return;
      const idx = tabs.findIndex((t) => t.id === activeTabId);
      const next = tabs[(idx + dir + tabs.length) % tabs.length].id;
      activateTab(next);
    },
    [tabs, activeTabId, activateTab]
  );

  const handleUndo = useCallback(() => {
    editorRef.current?.undo();
  }, []);

  const handleRedo = useCallback(() => {
    editorRef.current?.redo();
  }, []);

  // Working directory handed to the runner. Defaults to the folder opened via
  // "Open Folder" — scripts then resolve relative paths the way they would in
  // VSCode / PyCharm instead of inheriting the app's own directory. If no
  // usable folder is open we fall back to the script's own directory, never to
  // the app directory (which is what produced the PermissionError).
  // `hint` is set when the user is likely to be surprised by the location.
  const resolveRunCwd = useCallback(
    (filePath: string): { dir: string | null; hint: string | null } => {
      const custom = editorSettings.runCwdCustom.trim().replace(/^"+|"+$/g, "");
      switch (editorSettings.runCwdMode) {
        case "custom":
          if (!custom) {
            return {
              dir: dirName(filePath) || null,
              hint: t("run.hintNoCustom"),
            };
          }
          return { dir: custom, hint: null };
        case "script":
          return { dir: dirName(filePath) || null, hint: null };
        default: {
          if (explorer.folderPath) return { dir: explorer.folderPath, hint: null };
          // Relative paths still resolve (next to the script), but data files
          // silently pile up beside the script instead of in a project folder.
          return {
            dir: dirName(filePath) || null,
            hint: t("run.hintNoFolder"),
          };
        }
      }
    },
    // getI18nLocale() is in the deps so the localised hint is rebuilt on a
    // language change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editorSettings.runCwdMode, editorSettings.runCwdCustom, explorer.folderPath, getI18nLocale()]
  );
  const handleRun = useCallback(async () => {
    if (runner.running) {
      runner.stop();
      return;
    }
    const tab = activeTab;
    // The file must exist on disk: save (or save-as) first, then run it.
    let filePath = tab.filePath;
    if (!filePath || tab.modified) {
      filePath = await saveTabData(tab);
      if (!filePath) return; // save cancelled / failed
    }
    const lang = detectRunLanguage(tab.fileName);
    if (!lang) {
      setOutputOpen(true);
      runner.showLocal(t("run.noRunner"));
      return;
    }
    const conf = runner.config.find((c) => c.language === lang && c.enabled);
    if (!conf) {
      setOutputOpen(true);
      runner.showLocal(t("run.noInterpreter", { lang }));
      return;
    }
    setOutputOpen(true);
    const { dir, hint } = resolveRunCwd(filePath);
    await runner.run(conf.command, conf.args, filePath, dir, hint);
  }, [runner, activeTab, saveTabData, resolveRunCwd]);

  const handleOpenSearchResult = useCallback((path: string, line: number) => {
    revealLineRef.current = { path, line };
    openPaths([path]);
  }, [openPaths]);

  // After a cross-file-search result opens a file (or activates an existing
  // tab), move the caret to the matching line once the editor is mounted.
  useEffect(() => {
    const target = revealLineRef.current;
    if (!target || activeTab.filePath !== target.path) return;
    const raf = requestAnimationFrame(() => {
      editorRef.current?.goToLine(target.line);
      revealLineRef.current = null;
    });
    return () => cancelAnimationFrame(raf);
  }, [activeTab.id, activeTab.filePath]);

  const handleZoomIn = useCallback(() => {
    setEditorSettings((s) => ({ fontSize: Math.min(s.fontSize + 2, 32) }));
  }, [setEditorSettings]);

  const handleZoomOut = useCallback(() => {
    setEditorSettings((s) => ({ fontSize: Math.max(s.fontSize - 2, 8) }));
  }, [setEditorSettings]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case "n":
            e.preventDefault();
            newTab();
            break;
          case "o":
            e.preventDefault();
            openTab();
            break;
          case "s":
            e.preventDefault();
            if (e.shiftKey) saveActiveAs();
            else saveActive();
            break;
          case "f":
            e.preventDefault();
            if (e.shiftKey) setGlobalSearchOpen((o) => !o);
            else openSearch(false);
            break;
          case "h":
            e.preventDefault();
            openSearch(true);
            break;
          case "w":
            e.preventDefault();
            requestClose(activeTabId);
            break;
          case "tab":
            e.preventDefault();
            if (e.shiftKey) cycleTabs(-1);
            else cycleTabs(1);
            break;
          case "pageup":
            e.preventDefault();
            cycleTabs(-1);
            break;
          case "pagedown":
            e.preventDefault();
            cycleTabs(1);
            break;
          case "=":
          case "+":
            e.preventDefault();
            handleZoomIn();
            break;
          case "-":
            e.preventDefault();
            handleZoomOut();
            break;
          case "0":
            e.preventDefault();
            setEditorSettings({ fontSize: 14 });
            break;
          case "enter":
            e.preventDefault();
            handleRun();
            break;
        }
      }
      if (e.key === "F3") {
        e.preventDefault();
        if (!showSearch) openSearch(false);
        // When the search bar is open, its own listener handles F3 / Shift+F3.
      }
      if (e.key === "Escape") {
        closeSearch();
        setGlobalSearchOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [newTab, openTab, saveActive, saveActiveAs, openSearch, closeSearch, requestClose, activeTabId, cycleTabs, handleZoomIn, handleZoomOut, handleRun, showSearch]);

  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onDragEnter = (e: DragEvent) => {
      if (hasFiles(e)) setIsDragOver(true);
    };
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (hasFiles(e)) setIsDragOver(true);
    };
    const onDragLeave = () => setIsDragOver(false);
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);

    let unlisten: (() => void) | undefined;
    let onDropFiles: ((e: DragEvent) => void) | undefined;

    if ("__TAURI_INTERNALS__" in window) {
      // Desktop app: Tauri hands us the dropped file paths.
      let cancelled = false;
      getCurrentWindow()
        .onDragDropEvent((event) => {
          if (event.payload.type === "drop") openPaths(event.payload.paths);
        })
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    } else {
      // Plain-browser preview: read dropped files via the File API.
      onDropFiles = (e: DragEvent) => {
        const files = e.dataTransfer?.files;
        if (files && files.length) openFiles(Array.from(files));
      };
      window.addEventListener("drop", onDropFiles);
    }

    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      if (onDropFiles) window.removeEventListener("drop", onDropFiles);
      unlisten?.();
    };
  }, [openPaths, openFiles]);

  // Intercept the native window close in the desktop app so unsaved tabs get a
  // final "Save All / Don't Save / Cancel" prompt before the app exits.
  const unsavedTabsRef = useRef(unsavedTabs);
  unsavedTabsRef.current = unsavedTabs;

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((event) => {
        if (unsavedTabsRef.current.length === 0) return;
        event.preventDefault();
        setAppClosingTabs(unsavedTabsRef.current);
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, []);

  const handleAppCloseSaveAll = useCallback(async () => {
    if (!appClosingTabs) return;
    for (const tab of appClosingTabs) {
      const saved = await saveTabData(tab);
      if (!saved) return; // a Save-As was cancelled/failed -> stay in the window
    }
    persistSessionNow(); // record the now-saved state so a restart restores cleanly
    if ("__TAURI_INTERNALS__" in window) getCurrentWindow().destroy();
  }, [appClosingTabs, saveTabData, persistSessionNow]);

  const handleAppCloseDiscardAll = useCallback(() => {
    discardUnsavedFromSession(); // don't resurrect content the user explicitly discarded
    if ("__TAURI_INTERNALS__" in window) getCurrentWindow().destroy();
  }, [discardUnsavedFromSession]);

  const handleAppCloseCancel = useCallback(() => {
    setAppClosingTabs(null);
  }, []);

  return (
    <div className="h-screen bg-surface text-ink flex flex-col select-none overflow-hidden">
      <Toolbar
        onNew={newTab}
        onOpen={openTab}
        onSave={saveActive}
        onSaveAs={saveActiveAs}
        onSaveAll={saveAll}
        hasUnsaved={unsavedTabs.length > 0}
        onOpenFolder={explorer.openFolder}
        onToggleExplorer={explorer.toggle}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onSearch={toggleSearch}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        wrap={wrap}
        onToggleWrap={toggleWrap}
        recent={recentFiles}
        onOpenRecent={(path) => openPaths([path])}
        onClearRecent={clearRecent}
        modified={activeTab.modified}
        theme={theme}
        onCycleTheme={cycleTheme}
        mascotVisible={mascot.visible}
        onToggleMascot={mascot.toggle}
        running={runner.running}
        onRun={handleRun}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAbout={() => setAboutOpen(true)}
      />
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onActivate={activateTab}
        onClose={requestClose}
        onNew={newTab}
        onRename={renameTab}
        onMoveTab={moveTab}
      />
      {showSearch && (
        <SearchBar
          key={activeTab.id}
          editorRef={editorRef}
          onClose={closeSearch}
          showReplace={showReplace}
          onToggleReplace={() => setShowReplace((prev) => !prev)}
        />
      )}
      {globalSearchOpen && (
        <GlobalSearchPanel
          root={explorer.root?.path ?? null}
          onOpenResult={handleOpenSearchResult}
          onClose={() => setGlobalSearchOpen(false)}
        />
      )}
      <div className="flex-1 flex overflow-hidden">
        {explorer.isOpen ? (
          <>
            <FileExplorer
              root={explorer.root}
              expanded={explorer.expanded}
              activePath={activeTab.filePath}
              width={sidebarWidth}
              onOpenFolder={explorer.openFolder}
              onToggleDir={explorer.toggleDir}
              onExpandTo={explorer.expandTo}
              onOpenFile={(path) => openPaths([path])}
              onRename={handleRenameNode}
              onDelete={handleDeleteNode}
              onCreate={explorer.createNode}
              onClose={explorer.toggle}
            />
            <ResizeHandle onDrag={handleSidebarDrag} />
          </>
        ) : (
          <button
            onClick={explorer.toggle}
            title={t("app.showExplorer")}
            className="w-5 shrink-0 flex items-center justify-center bg-panel border-r border-line-soft text-faint hover:text-ink hover:bg-hover transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
        <div className="flex-1 overflow-hidden p-3">
          <div ref={splitRef} className="h-full flex">
            <div
              className="relative rounded-xl border border-line shadow-card overflow-hidden bg-editor"
              style={{ flex: previewOpen && isMarkdown ? editorRatio : 1, minWidth: 0 }}
            >
              <Editor
                key={activeTab.id}
                ref={editorRef}
                tabId={activeTab.id}
                content={activeTab.content}
                onChange={setActiveContent}
                onCursorChange={updateCursor}
                onSelectionChange={setSelectionLen}
                fontSize={editorSettings.fontSize}
                fontFamily={editorSettings.fontFamily}
                tabWidth={editorSettings.tabWidth}
                insertSpaces={editorSettings.insertSpaces}
                language={detectLanguage(activeTab.fileName)}
                wrap={wrap}
              />
              {isMarkdown && (
                <button
                  onClick={() => setPreviewOpen((o) => !o)}
                  title={previewOpen ? "Hide Markdown preview" : "Show Markdown preview"}
                  className={`absolute top-2 right-6 z-10 flex items-center justify-center w-7 h-7 rounded-md shadow-card transition-colors ${
                    previewOpen ? "accent-chip" : "bg-elevated border border-line text-sub hover:text-ink hover:bg-hover"
                  }`}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
              )}
            </div>
            {previewOpen && isMarkdown && (
              <>
                <ResizeHandle onDrag={handleSplitDrag} />
                <div
                  className="rounded-xl border border-line shadow-card overflow-hidden bg-editor"
                  style={{ flex: 1 - editorRatio, minWidth: 0 }}
                >
                  <MarkdownPreview content={activeTab.content} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {outputOpen && (
        <OutputPanel
          output={runner.output}
          running={runner.running}
          lastExit={runner.lastExit}
          onClear={runner.clearOutput}
          onStop={runner.stop}
          onClose={() => setOutputOpen(false)}
        />
      )}
      <StatusBar
        line={cursorLine}
        col={cursorCol}
        totalLines={totalLines}
        fontSize={editorSettings.fontSize}
        tabWidth={editorSettings.tabWidth}
        insertSpaces={editorSettings.insertSpaces}
        largeFile={activeLargeFile}
        selectionLen={selectionLen}
        encoding={activeTab.encoding}
        onChangeEncoding={(enc) => setTabEncoding(activeTab.id, enc)}
      />
      {isDragOver && (
        <div className="fixed inset-0 z-40 pointer-events-none flex items-center justify-center">
          <div className="absolute inset-0 bg-black/45" />
          <div className="relative border-2 border-dashed border-accent rounded-2xl px-10 py-6 bg-elevated shadow-2xl">
            <div className="flex items-center gap-3">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <p className="text-ink text-lg">{t("app.dropToOpen")}</p>
            </div>
          </div>
        </div>
      )}
      {mascot.visible && (
        <Mascot
          typingTick={typingTick}
          initialPos={mascot.loadPos()}
          onSavePos={mascot.savePos}
          onHide={mascot.toggle}
        />
      )}
      {appClosingTabs && (
        <ConfirmAppCloseDialog
          unsavedTabs={appClosingTabs}
          onSaveAll={handleAppCloseSaveAll}
          onDiscardAll={handleAppCloseDiscardAll}
          onCancel={handleAppCloseCancel}
        />
      )}
      {pendingClose && (
        <ConfirmCloseDialog
          fileName={pendingClose.fileName}
          unsaved={pendingClose.filePath === null}
          onSave={() => confirmPendingClose(true)}
          onDiscard={() => confirmPendingClose(false)}
          onCancel={cancelPendingClose}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          config={runner.config}
          onSet={runner.setInterpreter}
          onApplyDetected={runner.applyDetected}
          editorSettings={editorSettings}
          onSetEditor={setEditorSettings}
          updater={updater}
          onInstallUpdate={installUpdate}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </div>
  );
}

export default App;
