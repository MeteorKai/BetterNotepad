import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Eol } from "./useEditorSettings";
import { t } from "../i18n";

export interface BrowserFileHandle {
  name: string;
  createWritable(): Promise<{
    write(data: string): Promise<void>;
    close(): Promise<void>;
  }>;
}

export interface Tab {
  id: string;
  filePath: string | null;
  fileName: string;
  content: string;
  modified: boolean;
  encoding: string;
  eol?: Eol;
  fileHandle?: BrowserFileHandle;
}

export function isTabUnsaved(tab: Tab): boolean {
  return tab.content.length > 0 && (tab.modified || !tab.filePath);
}

export const ENCODING_OPTIONS: { id: string; label: string }[] = [
  { id: "utf-8", label: "UTF-8" },
  { id: "utf-8-bom", label: "UTF-8 with BOM" },
  { id: "gbk", label: "GBK" },
  { id: "utf-16le", label: "UTF-16 LE" },
  { id: "utf-16be", label: "UTF-16 BE" },
];

export function detectEol(content: string): Eol {
  return content.includes("\r\n") ? "crlf" : "lf";
}

function normalizeEol(content: string, eol: Eol): string {
  return eol === "crlf"
    ? content.replace(/\r?\n/g, "\r\n")
    : content.replace(/\r\n/g, "\n");
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string;
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `tab-${Date.now().toString(36)}-${idCounter}`;
}

function createTab(): Tab {
  // The placeholder name is shown as the tab label and used as the Save-As
  // default, so it follows the current UI language.
  return { id: newId(), filePath: null, fileName: t("tab.untitled"), content: "", modified: false, encoding: "utf-8" };
}

// Built lazily: the filter captions appear in the native file dialog and
// should follow the language picked in Settings.
const openFilters = () => [
  { name: t("dialog.allFiles"), extensions: ["*"] },
  { name: t("dialog.textFiles"), extensions: ["txt", "md", "rs", "ts", "tsx", "js", "json", "py", "go", "c", "cpp", "h", "java", "html", "css", "xml", "yaml", "yml", "toml"] },
];

const saveFilters = () => [
  { name: t("dialog.textFiles"), extensions: ["txt"] },
  { name: t("dialog.allFiles"), extensions: ["*"] },
];

const SESSION_KEY = "betternotepad.session";
const SESSION_VERSION = 1;
// Above this much buffered text the session stops carrying the content of
// saved, unmodified tabs. They are reloaded from disk on restore anyway, so
// keeping their content only buys a synchronous multi-megabyte storage write.
const SESSION_CONTENT_BUDGET = 512_000;

interface SessionEntry {
  filePath: string | null;
  fileName: string;
  content: string;
  modified: boolean;
  encoding: string;
  eol?: Eol;
}

interface SessionSnapshot {
  version: number;
  activeIndex: number;
  tabs: SessionEntry[];
}

function buildSession(state: TabsState): SessionSnapshot {
  return {
    version: SESSION_VERSION,
    activeIndex: Math.max(0, state.tabs.findIndex((t) => t.id === state.activeTabId)),
    tabs: state.tabs.map((t) => ({
      filePath: t.filePath,
      fileName: t.fileName,
      content: t.content,
      modified: t.modified,
      encoding: t.encoding,
      eol: t.eol,
    })),
  };
}

// Summing content lengths is a cheap lower bound for the serialized size and,
// unlike JSON.stringify, costs nothing on multi-megabyte tabs.
function contentSize(tabs: SessionEntry[]): number {
  let total = 0;
  for (const t of tabs) total += t.content.length;
  return total;
}

function serializeSession(snapshot: SessionSnapshot): string {
  let tabs = snapshot.tabs;
  // Drop content of saved, unmodified tabs once the buffer gets large: a restore
  // reads it back from disk instead, so keeping it only buys a synchronous
  // multi-megabyte storage write.
  if (contentSize(tabs) > SESSION_CONTENT_BUDGET) {
    tabs = tabs.map((e) => (e.filePath && !e.modified ? { ...e, content: "" } : e));
  }
  // Modified or never-saved content is kept whatever the size: dropping it would
  // silently lose edits when the session is restored.
  return JSON.stringify(tabs === snapshot.tabs ? snapshot : { ...snapshot, tabs });
}

function loadSession(): SessionSnapshot | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionSnapshot;
    if (!parsed || parsed.version !== SESSION_VERSION || !Array.isArray(parsed.tabs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface RecentFile {
  path: string;
  name: string;
}

const RECENT_KEY = "betternotepad.recent";
const RECENT_MAX = 10;

function loadRecent(): RecentFile[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is RecentFile => !!r && typeof r.path === "string" && typeof r.name === "string")
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

export function useTabs(options?: { defaultEol?: Eol }) {
  const defaultEolRef = useRef<Eol>(options?.defaultEol ?? "lf");
  defaultEolRef.current = options?.defaultEol ?? "lf";

  const [state, setState] = useState<TabsState>(() => {
    const saved = loadSession();
    if (saved && saved.tabs.length > 0) {
      const tabs: Tab[] = saved.tabs
        // Skip untouched empty "Untitled" tabs.
        .filter((e) => !(e.filePath === null && e.content === ""))
        .map((e) => ({
          id: newId(),
          filePath: e.filePath,
          fileName: e.fileName,
          content: e.content,
          modified: e.modified,
          encoding: e.encoding ?? "utf-8",
          eol: e.eol ?? detectEol(e.content),
        }));
      if (tabs.length > 0) {
        const activeIndex = Math.min(Math.max(0, saved.activeIndex), tabs.length - 1);
        return { tabs, activeTabId: tabs[activeIndex].id };
      }
    }
    const first = createTab();
    return { tabs: [first], activeTabId: first.id };
  });

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];
  const unsavedTabs = state.tabs.filter(isTabUnsaved);

  // Refs to always read the latest tab state from stable callbacks.
  const tabsRef = useRef(state.tabs);
  tabsRef.current = state.tabs;
  const activeTabIdRef = useRef(state.activeTabId);
  activeTabIdRef.current = state.activeTabId;
  const initialTabsRef = useRef(state.tabs);

  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(() => loadRecent());

  useEffect(() => {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentFiles));
    } catch {
      // ignore
    }
  }, [recentFiles]);

  const recordRecent = useCallback((path: string, name: string) => {
    setRecentFiles((prev) => [
      { path, name },
      ...prev.filter((r) => r.path !== path),
    ].slice(0, RECENT_MAX));
  }, []);

  const clearRecent = useCallback(() => setRecentFiles([]), []);

  const activateTab = useCallback((id: string) => {
    setState((s) => (s.activeTabId === id ? s : { ...s, activeTabId: id }));
  }, []);

  // Move a tab so it sits immediately before `beforeId` (or to the end when
  // beforeId is omitted). The active tab id is untouched, so drag-reordering
  // never changes which tab is focused.
  const moveTab = useCallback((id: string, beforeId?: string) => {
    setState((s) => {
      const from = s.tabs.findIndex((t) => t.id === id);
      if (from === -1 || id === beforeId) return s;
      const tabs = [...s.tabs];
      const [moved] = tabs.splice(from, 1);
      if (!beforeId) {
        tabs.push(moved);
      } else {
        const to = tabs.findIndex((t) => t.id === beforeId);
        if (to === -1) tabs.push(moved);
        else tabs.splice(to, 0, moved);
      }
      return { ...s, tabs };
    });
  }, []);

  const patchTab = useCallback((id: string, patch: Partial<Tab>) => {
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
  }, []);

  const lastSessionRef = useRef<string | null>(null);

  const writeSession = useCallback((snapshot: SessionSnapshot) => {
    try {
      const serialized = serializeSession(snapshot);
      // localStorage writes are synchronous; skip the ones that change nothing.
      if (serialized === lastSessionRef.current) return;
      localStorage.setItem(SESSION_KEY, serialized);
      // Only remember it once the write actually succeeded, so a quota failure
      // is retried rather than silently giving up.
      lastSessionRef.current = serialized;
    } catch (err) {
      console.warn("Failed to persist session:", err);
    }
  }, []);

  const persistSessionNow = useCallback(() => {
    writeSession(buildSession({ tabs: tabsRef.current, activeTabId: activeTabIdRef.current }));
  }, [writeSession]);

  const discardUnsavedFromSession = useCallback(() => {
    const snapshot = buildSession({ tabs: tabsRef.current, activeTabId: activeTabIdRef.current });
    snapshot.tabs = snapshot.tabs.filter(
      (e) => !(e.content.length > 0 && (e.modified || !e.filePath))
    );
    writeSession(snapshot);
  }, [writeSession]);

  useEffect(() => {
    // Serializing megabytes of buffered text blocks the main thread, so back off
    // further before persisting a large snapshot.
    const delay = contentSize(state.tabs) > SESSION_CONTENT_BUDGET ? 2000 : 400;
    const timer = window.setTimeout(persistSessionNow, delay);
    return () => window.clearTimeout(timer);
  }, [state.tabs, state.activeTabId, persistSessionNow]);

  // Reload from disk any restored saved tab whose content was stripped to fit the storage cap.
  useEffect(() => {
    let cancelled = false;
    const missing = initialTabsRef.current.filter((t) => t.filePath && !t.content && !t.modified);
    (async () => {
      for (const tab of missing) {
        try {
          const { content, encoding } = await invoke<{ content: string; encoding: string }>("read_file", {
            path: tab.filePath!,
          });
          if (cancelled) return;
          patchTab(tab.id, { content, modified: false, encoding, eol: detectEol(content) });
        } catch (err) {
          console.error("Failed to reload session tab:", tab.filePath, err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [patchTab]);

  const setActiveContent = useCallback((content: string) => {
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) =>
        t.id === s.activeTabId ? { ...t, content, modified: true } : t
      ),
    }));
  }, []);

  const renameTab = useCallback((id: string, fileName: string) => {
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, fileName } : t)),
    }));
  }, []);

  const setTabEncoding = useCallback((id: string, encoding: string) => {
    patchTab(id, { encoding });
  }, [patchTab]);

  const newTab = useCallback(() => {
    const nt = createTab();
    setState((s) => ({ tabs: [...s.tabs, nt], activeTabId: nt.id }));
  }, []);

  const addTabs = useCallback(
    (loaded: Array<{ filePath: string | null; fileName: string; content: string; encoding: string; eol?: Eol }>) => {
      if (!loaded.length) return;
      setState((s) => {
        const tabs = [...s.tabs];
        let activeTabId = s.activeTabId;
        for (const item of loaded) {
          const existing = item.filePath
            ? tabs.find((t) => t.filePath === item.filePath)
            : undefined;
          if (existing) {
            activeTabId = existing.id;
          } else {
            const tab: Tab = {
              id: newId(),
              filePath: item.filePath,
              fileName: item.fileName,
              content: item.content,
              modified: false,
              encoding: item.encoding,
              eol: item.eol ?? detectEol(item.content),
            };
            tabs.push(tab);
            activeTabId = tab.id;
          }
        }
        return { tabs, activeTabId };
      });
    },
    []
  );

  const openPaths = useCallback(
    async (paths: string[]) => {
      const loaded: Array<{ filePath: string | null; fileName: string; content: string; encoding: string; eol?: Eol }> = [];
      for (const path of paths) {
        try {
          const [{ content, encoding }, name] = await Promise.all([
            invoke<{ content: string; encoding: string }>("read_file", { path }),
            invoke<string>("get_file_name", { path }),
          ]);
          loaded.push({ filePath: path, fileName: name, content, encoding, eol: detectEol(content) });
          recordRecent(path, name);
        } catch (err) {
          console.error("Failed to read file:", path, err);
        }
      }
      addTabs(loaded);
    },
    [addTabs, recordRecent]
  );

  const openFiles = useCallback(
    async (files: File[]) => {
      const loaded: Array<{ filePath: string | null; fileName: string; content: string; encoding: string; eol?: Eol }> = [];
      for (const file of files) {
        try {
          const content = await file.text();
          loaded.push({ filePath: null, fileName: file.name, content, encoding: "utf-8", eol: detectEol(content) });
        } catch (err) {
          console.error("Failed to read dropped file:", file.name, err);
        }
      }
      addTabs(loaded);
    },
    [addTabs]
  );

  const openTab = useCallback(async () => {
    try {
      const selected = await open({ multiple: true, filters: openFilters() });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await openPaths(paths);
    } catch (err) {
      console.error("Failed to open file:", err);
    }
  }, [openPaths]);

  const saveTabAs = useCallback(
    async (tab: Tab): Promise<string | null> => {
      const outContent = normalizeEol(tab.content, tab.eol ?? defaultEolRef.current);
      try {
        if ("__TAURI_INTERNALS__" in window) {
          const selected = await save({ defaultPath: tab.fileName, filters: saveFilters() });
          if (!selected) return null;
          await invoke("write_file", { path: selected, content: outContent, encoding: tab.encoding });
          const name = await invoke<string>("get_file_name", { path: selected });
          patchTab(tab.id, { filePath: selected, fileName: name, modified: false });
          return selected;
        }
        // Plain-browser preview: real save dialog (Chromium) if available…
        if ("showSaveFilePicker" in window) {
          try {
            const picker = (window as unknown as {
              showSaveFilePicker: (o: object) => Promise<BrowserFileHandle>;
            }).showSaveFilePicker;
            const handle = await picker.call(window, {
              suggestedName: tab.fileName || "Untitled.txt",
              types: [
                {
                  description: t("dialog.textFiles"),
                  accept: {
                    "text/plain": [".txt", ".md", ".ts", ".tsx", ".js", ".json", ".py", ".rs", ".go", ".html", ".css", ".xml", ".yaml", ".yml", ".toml", ".c", ".cpp", ".h", ".java", ".csv"],
                  },
                },
                { description: t("dialog.allFiles"), accept: { "application/octet-stream": [".*"] } },
              ],
            });
            const writable = await handle.createWritable();
            await writable.write(outContent);
            await writable.close();
            patchTab(tab.id, { fileHandle: handle, fileName: handle.name, modified: false });
            return null;
          } catch (err) {
            if ((err as Error).name === "AbortError") return null;
            // Any other error: fall through to the download fallback.
          }
        }
        // …otherwise download the content as a file.
        const blob = new Blob([outContent], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const name = tab.fileName || "Untitled.txt";
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        patchTab(tab.id, { fileName: name, modified: false });
        return null;
      } catch (err) {
        console.error("Failed to save file as:", err);
        return null;
      }
    },
    [patchTab]
  );

  const saveTabData = useCallback(
    async (tab: Tab): Promise<string | null> => {
      const outContent = normalizeEol(tab.content, tab.eol ?? defaultEolRef.current);
      try {
        if (tab.filePath) {
          await invoke("write_file", { path: tab.filePath, content: outContent, encoding: tab.encoding });
          patchTab(tab.id, { modified: false });
          return tab.filePath;
        }
        if (tab.fileHandle) {
          const writable = await tab.fileHandle.createWritable();
          await writable.write(outContent);
          await writable.close();
          patchTab(tab.id, { modified: false });
          return null;
        }
        return await saveTabAs(tab);
      } catch (err) {
        console.error("Failed to save file:", err);
        return null;
      }
    },
    [patchTab, saveTabAs]
  );

  const saveActiveAs = useCallback(async () => {
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab) return;
    await saveTabAs(tab);
  }, [state, saveTabAs]);

  const saveActive = useCallback(async () => {
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab) return;
    await saveTabData(tab);
  }, [state, saveTabData]);

  // Save every unsaved tab in order. Stops if a Save-As dialog is cancelled
  // (the tab stays `modified`), so the user can retry.
  const saveAll = useCallback(async (): Promise<boolean> => {
    for (const tab of tabsRef.current) {
      if (!isTabUnsaved(tab)) continue;
      await saveTabData(tab);
      const updated = tabsRef.current.find((t) => t.id === tab.id);
      if (updated && updated.modified) return false;
    }
    return true;
  }, [saveTabData]);

  const [pendingClose, setPendingClose] = useState<Tab | null>(null);

  const closeTab = useCallback((id: string) => {
    setState((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (tabs.length === 0) {
        const nt = createTab();
        return { tabs: [nt], activeTabId: nt.id };
      }
      const activeTabId =
        s.activeTabId === id ? tabs[Math.min(idx, tabs.length - 1)].id : s.activeTabId;
      return { tabs, activeTabId };
    });
  }, []);

  const requestClose = useCallback(
    (id: string) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return;
      // Only prompt when there is actual content to lose: a tab that is empty
      // closes directly, even if it was created but never saved.
      if (isTabUnsaved(tab)) setPendingClose(tab);
      else closeTab(id);
    },
    [state, closeTab]
  );

  const renameOpenFile = useCallback((oldPath: string, newPath: string, newName: string) => {
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) =>
        t.filePath === oldPath ? { ...t, filePath: newPath, fileName: newName } : t
      ),
    }));
  }, []);

  const closeOpenFile = useCallback((path: string) => {
    setState((s) => {
      const tabs = s.tabs.filter((t) => t.filePath !== path);
      if (tabs.length === 0) {
        const nt = createTab();
        return { tabs: [nt], activeTabId: nt.id };
      }
      const activeTabId = tabs.some((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : tabs[0].id;
      return { tabs, activeTabId };
    });
  }, []);

  const cancelPendingClose = useCallback(() => setPendingClose(null), []);

  const confirmPendingClose = useCallback(
    async (shouldSave: boolean) => {
      const tab = pendingClose;
      setPendingClose(null);
      if (!tab) return;
      if (!shouldSave) {
        closeTab(tab.id);
        return;
      }
      const saved = await saveTabData(tab);
      if (saved) closeTab(tab.id);
      // If saving was cancelled or failed, keep the tab open.
    },
    [pendingClose, closeTab, saveTabData]
  );

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
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
    closeTab,
    requestClose,
    renameOpenFile,
    closeOpenFile,
    pendingClose,
    cancelPendingClose,
    confirmPendingClose,
  };
}
