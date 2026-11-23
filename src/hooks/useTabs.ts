import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { watchImmediate } from "@tauri-apps/plugin-fs";
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
  diskVersion?: string;
  diskStamp?: string;
  externalChange?: "changed" | "missing";
  reloadRevision?: number;
  needsDiskLoad?: boolean;
  diskLoadError?: string;
  isDefaultPlaceholder?: boolean;
}

export function isTabUnsaved(tab: Tab): boolean {
  return tab.modified || (!tab.filePath && tab.content.length > 0) ||
    (tab.externalChange === "missing" && tab.content.length > 0);
}

export function isPathAffected(filePath: string | null, path: string, isDir = false): boolean {
  if (!filePath) return false;
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
    // Windows drive and UNC paths are case-insensitive; POSIX paths are not.
    return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const file = normalize(filePath);
  const target = normalize(path);
  return file === target || (isDir && file.startsWith(`${target}/`));
}

interface ReadFileResult {
  content: string;
  encoding: string;
  fingerprint: string;
  stamp?: string | null;
}

interface FileRevision {
  fingerprint: string | null;
  stamp: string | null;
  unchanged: boolean;
}

function parentDirectory(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash < 0 ? "." : path.slice(0, slash + 1);
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
  closedTabs: ClosedTab[];
}

interface ClosedTab {
  tab: Tab;
  index: number;
}

const CLOSED_TABS_MAX = 20;

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `tab-${Date.now().toString(36)}-${idCounter}`;
}

function createTab(): Tab {
  // The placeholder name is shown as the tab label and used as the Save-As
  // default, so it follows the current UI language.
  return { id: newId(), filePath: null, fileName: t("tab.untitled"), content: "", modified: false, encoding: "utf-8", isDefaultPlaceholder: true };
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
const SESSION_MAX_DELAY_MS = 5_000;
const MAX_EDITOR_FILE_BYTES = 64 * 1024 * 1024;

type FileNotice = { message: string; details?: string };

function fileError(error: unknown): string {
  const reason = String(error);
  if (reason.includes("FILE_TOO_LARGE")) return t("file.tooLarge");
  if (reason.includes("FILE_BUSY")) return t("file.busy");
  if (reason.includes("UNREPRESENTABLE_TEXT")) return t("file.encodingLoss");
  if (reason.includes("INVALID_TEXT_ENCODING") || reason.includes("BINARY_FILE")) return t("file.invalidText");
  if (reason.includes("FILE_CHANGED_EXTERNALLY")) return t("file.destinationChanged");
  return reason;
}

interface SessionEntry {
  filePath: string | null;
  fileName: string;
  content: string;
  modified: boolean;
  encoding: string;
  eol?: Eol;
  diskVersion?: string;
  externalChange?: "changed" | "missing";
  needsDiskLoad?: boolean;
}

interface SessionSnapshot {
  version: number;
  activeIndex: number;
  tabs: SessionEntry[];
}

function buildSession(state: Pick<TabsState, "tabs" | "activeTabId">): SessionSnapshot {
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
      diskVersion: t.diskVersion,
      externalChange: t.externalChange,
      needsDiskLoad: t.needsDiskLoad || undefined,
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
    tabs = tabs.map((e) => (e.filePath && !e.modified && !e.externalChange ? { ...e, content: "", needsDiskLoad: true } : e));
  }
  // Modified or never-saved content is kept whatever the size: dropping it would
  // silently lose edits when the session is restored.
  return JSON.stringify(tabs === snapshot.tabs ? snapshot : { ...snapshot, tabs });
}

export interface DesktopSession {
  contents: string | null;
  loadFailed?: boolean;
}

function parseSession(raw: string): SessionSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as SessionSnapshot;
    if (parsed?.version !== SESSION_VERSION || !Number.isInteger(parsed.activeIndex) ||
        !Array.isArray(parsed.tabs) || !parsed.tabs.every((entry) => entry &&
          (entry.filePath === null || typeof entry.filePath === "string") &&
          typeof entry.fileName === "string" && typeof entry.content === "string" &&
          typeof entry.modified === "boolean")) return null;
    return parsed;
  } catch {
    return null;
  }
}

function loadSession(): SessionSnapshot | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw === null ? null : parseSession(raw);
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

export function useTabs(options?: { defaultEol?: Eol; desktopSession?: DesktopSession }) {
  const defaultEolRef = useRef<Eol>(options?.defaultEol ?? "lf");
  defaultEolRef.current = options?.defaultEol ?? "lf";

  const [initialSession] = useState(() => {
    const desktop = options?.desktopSession;
    if (desktop?.loadFailed) return { snapshot: null, blocked: true };
    if (desktop?.contents != null) {
      const snapshot = parseSession(desktop.contents);
      return { snapshot, blocked: !snapshot };
    }
    return { snapshot: loadSession(), blocked: false };
  });
  const [state, setState] = useState<TabsState>(() => {
    const saved = initialSession.snapshot;
    if (saved && saved.tabs.length > 0) {
      const entries = saved.tabs.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
        entry.filePath !== null || entry.content !== "" || entry.modified
      );
      const tabs: Tab[] = entries.map(({ entry: e }) => ({
          id: newId(),
          filePath: e.filePath,
          fileName: e.fileName,
          content: e.content,
          modified: e.modified,
          encoding: e.encoding ?? "utf-8",
          eol: e.eol ?? detectEol(e.content),
          diskVersion: e.diskVersion,
          externalChange: e.externalChange,
          needsDiskLoad: !!e.filePath && !e.modified && e.content === "" &&
            (e.needsDiskLoad === true || !e.externalChange),
        }));
      if (tabs.length > 0) {
        const nextIndex = entries.findIndex(({ index }) => index >= saved.activeIndex);
        const activeIndex = nextIndex < 0 ? tabs.length - 1 : nextIndex;
        return { tabs, activeTabId: tabs[activeIndex].id, closedTabs: [] };
      }
    }
    const first = createTab();
    return { tabs: [first], activeTabId: first.id, closedTabs: [] };
  });

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];
  const unsavedTabs = state.tabs.filter(isTabUnsaved);

  // Refs to always read the latest tab state from stable callbacks.
  const tabsRef = useRef(state.tabs);
  tabsRef.current = state.tabs;
  const activeTabIdRef = useRef(state.activeTabId);
  activeTabIdRef.current = state.activeTabId;
  const editEpochRef = useRef(new Map<string, number>());
  const [fileNotice, setFileNotice] = useState<FileNotice | null>(null);
  const [sessionError, setSessionError] = useState<false | "read" | "write" | "limit">(initialSession.blocked ? "read" : false);

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

  const lastSessionRef = useRef(options?.desktopSession?.contents ?? null);
  const sessionWritesRef = useRef(Promise.resolve(true));
  const autoBackupRunning = useRef(false);
  const autoBackupRequested = useRef(false);
  const backupScheduledSince = useRef<number | null>(null);
  const discardPendingRef = useRef(false);
  const desktopBackup = options?.desktopSession !== undefined;

  const writeSession = useCallback((discard: boolean, force: boolean): Promise<boolean> => {
    if (initialSession.blocked) return Promise.resolve(false);
    const task = sessionWritesRef.current.then(async () => {
      try {
        // Read the latest committed tabs when this write gets its turn.
        const tabs = discard ? tabsRef.current.filter((tab) => !isTabUnsaved(tab)) : tabsRef.current;
        const serialized = serializeSession(buildSession({ tabs, activeTabId: activeTabIdRef.current }));
        if (force || serialized !== lastSessionRef.current) {
          if (desktopBackup) await invoke("save_session_backup", { contents: serialized });
          else localStorage.setItem(SESSION_KEY, serialized);
          lastSessionRef.current = serialized;
        }
        setSessionError(false);
        return true;
      } catch (err) {
        // An earlier successful write does not prove the destination is still
        // usable. Retry even if the current snapshot has the same contents.
        lastSessionRef.current = null;
        console.warn("Failed to persist session:", err);
        setSessionError(String(err).includes("SESSION_TOO_LARGE") ? "limit" : "write");
        return false;
      }
    });
    sessionWritesRef.current = task;
    return task;
  }, [desktopBackup, initialSession.blocked]);

  const persistSessionNow = useCallback((force = true) => {
    if (discardPendingRef.current) return Promise.resolve(false);
    return writeSession(false, force);
  }, [writeSession]);

  const discardUnsavedFromSession = useCallback(async () => {
    discardPendingRef.current = true;
    const saved = await writeSession(true, true);
    if (!saved) discardPendingRef.current = false;
    return saved;
  }, [writeSession]);

  const resumeSessionBackup = useCallback(() => {
    discardPendingRef.current = false;
  }, []);

  useEffect(() => {
    // Serializing megabytes of buffered text blocks the main thread, so back off
    // further before persisting a large snapshot.
    const now = Date.now();
    backupScheduledSince.current ??= now;
    const idleDelay = contentSize(state.tabs) > SESSION_CONTENT_BUDGET ? 2000 : 400;
    const delay = Math.max(0, Math.min(idleDelay, SESSION_MAX_DELAY_MS - (now - backupScheduledSince.current)));
    const timer = window.setTimeout(async () => {
      backupScheduledSince.current = null;
      autoBackupRequested.current = true;
      if (autoBackupRunning.current) return;
      autoBackupRunning.current = true;
      try {
        // Coalesce timer firings, but never lose the last edit when a timer
        // fires while writing to a slow drive.
        while (autoBackupRequested.current) {
          autoBackupRequested.current = false;
          await persistSessionNow(false);
        }
      } finally {
        autoBackupRunning.current = false;
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [state.tabs, state.activeTabId, persistSessionNow]);

  const savingPathsRef = useRef(new Set<string>());
  const saveDialogsRef = useRef(new Set<string>());
  const pathIsSaving = useCallback((path: string) =>
    [...savingPathsRef.current].some((pending) => isPathAffected(pending, path)), []);
  const pendingDirectoriesRef = useRef(new Set<string>());
  const touchedPathsRef = useRef(new Set<string>());
  const scanTimerRef = useRef<number | null>(null);
  const scanningRef = useRef(false);

  const reconcilePath = useCallback(async (path: string, forceContentCheck: boolean) => {
    if (pathIsSaving(path)) return;
    const observed = tabsRef.current.find((tab) => tab.filePath === path);
    if (!observed) return;
    let revision: FileRevision;
    try {
      revision = await invoke<FileRevision>("check_file_revision", {
        path,
        knownStamp: forceContentCheck || observed.needsDiskLoad || observed.externalChange ? undefined : observed.diskStamp,
      });
    } catch (err) {
      if (observed.needsDiskLoad && !pathIsSaving(path)) {
        const details = fileError(err);
        setState((state) => {
          const current = state.tabs.find((tab) => tab.id === observed.id);
          if (!current?.needsDiskLoad || current.filePath !== path || current.diskLoadError === details) return state;
          return { ...state, tabs: state.tabs.map((tab) => tab === current ? { ...tab, diskLoadError: details } : tab) };
        });
      }
      return;
    }
    if (pathIsSaving(path) || revision.unchanged) return;
    const { fingerprint, stamp } = revision;

    if (fingerprint === null) {
      setState((s) => {
        let changed = false;
        const tabs = s.tabs.map((tab) => {
          if (tab.filePath !== path || tab.diskVersion !== observed.diskVersion || tab.externalChange === "missing" || tab.externalChange === "changed") return tab;
          changed = true;
          return { ...tab, externalChange: "missing" as const };
        });
        return changed ? { ...s, tabs } : s;
      });
      return;
    }

    const needsContent = tabsRef.current.some((tab) =>
      tab.filePath === path && !tab.modified &&
      (tab.diskVersion !== fingerprint || tab.needsDiskLoad)
    );
    if (!needsContent) {
      setState((s) => {
        let changed = false;
        const tabs = s.tabs.map((tab) => {
          if (tab.filePath !== path || tab.diskVersion !== observed.diskVersion) return tab;
          const externalChange = tab.externalChange === "changed" || tab.diskVersion !== fingerprint
            ? "changed" as const : undefined;
          const diskStamp = externalChange ? undefined : stamp ?? undefined;
          if (tab.externalChange === externalChange && tab.diskStamp === diskStamp) return tab;
          changed = true;
          return { ...tab, diskStamp, externalChange };
        });
        return changed ? { ...s, tabs } : s;
      });
      return;
    }

    let disk: ReadFileResult;
    try {
      disk = await invoke<ReadFileResult>("read_file", { path });
    } catch (err) {
      // A rename-style save may temporarily remove the path. The next watch
      // event or window-focus check will retry without touching local text.
      if (observed.needsDiskLoad && !pathIsSaving(path)) {
        const details = fileError(err);
        setState((state) => {
          const tabs = state.tabs.map((tab) => tab.id === observed.id && tab.filePath === path &&
            tab.needsDiskLoad && tab.diskVersion === observed.diskVersion && tab.diskLoadError !== details
            ? { ...tab, diskLoadError: details } : tab);
          return tabs.some((tab, index) => tab !== state.tabs[index]) ? { ...state, tabs } : state;
        });
      }
      return;
    }
    if (pathIsSaving(path)) return;
    setState((s) => {
      let changed = false;
      const tabs = s.tabs.map((tab) => {
        if (tab.filePath !== path || tab.diskVersion !== observed.diskVersion) return tab;
        if (tab.modified) {
          const externalChange = tab.externalChange === "changed" || tab.diskVersion !== disk.fingerprint
            ? "changed" : undefined;
          if (tab.externalChange === externalChange) return tab;
          changed = true;
          return { ...tab, externalChange: externalChange as Tab["externalChange"] };
        }
        if (tab.diskVersion === disk.fingerprint && !tab.needsDiskLoad) {
          const diskStamp = disk.stamp ?? undefined;
          if (!tab.externalChange && tab.diskStamp === diskStamp) return tab;
          changed = true;
          return { ...tab, diskStamp, externalChange: undefined };
        }
        changed = true;
        return {
          ...tab,
          content: disk.content,
          encoding: disk.encoding,
          eol: detectEol(disk.content),
          diskVersion: disk.fingerprint,
          diskStamp: disk.stamp ?? undefined,
          modified: false,
          externalChange: undefined,
          needsDiskLoad: false,
          diskLoadError: undefined,
          reloadRevision: (tab.reloadRevision ?? 0) + 1,
        };
      });
      return changed ? { ...s, tabs } : s;
    });
  }, [pathIsSaving]);

  const drainReconcile = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    try {
      while (pendingDirectoriesRef.current.size > 0) {
        const directories = new Set(pendingDirectoriesRef.current);
        pendingDirectoriesRef.current.clear();
        const touched = new Set(touchedPathsRef.current);
        touchedPathsRef.current.clear();
        const paths = [...new Set(tabsRef.current.flatMap((tab) =>
          tab.filePath && (directories.has("*") || directories.has(parentDirectory(tab.filePath)))
            ? [tab.filePath] : []
        ))];
        for (let i = 0; i < paths.length; i += 4) {
          await Promise.all(paths.slice(i, i + 4).map((path) => reconcilePath(path, touched.has(path))));
        }
      }
    } finally {
      scanningRef.current = false;
      if (pendingDirectoriesRef.current.size > 0) void drainReconcile();
    }
  }, [reconcilePath]);

  const scheduleReconcile = useCallback((directory?: string) => {
    pendingDirectoriesRef.current.add(directory ?? "*");
    if (scanTimerRef.current !== null) return;
    scanTimerRef.current = window.setTimeout(() => {
      scanTimerRef.current = null;
      void drainReconcile();
    }, 250);
  }, [drainReconcile]);

  const watchedDirectories = [...new Set(state.tabs.flatMap((tab) =>
    tab.filePath ? [parentDirectory(tab.filePath)] : []
  ))].sort().join("\0");

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    scheduleReconcile();
    if (!watchedDirectories) return;
    let disposed = false;
    const unwatchers: Array<() => void> = [];
    const pollers: number[] = [];
    for (const directory of watchedDirectories.split("\0")) {
      void watchImmediate(directory, (event) => {
        // Reading a file must not trigger another read loop on platforms that
        // report access events.
        if (typeof event.type === "object" && "access" in event.type) return;
        for (const tab of tabsRef.current) {
          if (tab.filePath && event.paths.some((path) => isPathAffected(tab.filePath, path))) {
            touchedPathsRef.current.add(tab.filePath);
          }
        }
        scheduleReconcile(directory);
      }, { recursive: false }).then((unwatch) => {
        if (disposed) unwatch();
        else unwatchers.push(unwatch);
      }).catch((err) => {
        if (disposed) return;
        console.error("Failed to watch directory; polling instead:", directory, err);
        pollers.push(window.setInterval(() => scheduleReconcile(directory), 2000));
      });
    }
    return () => {
      disposed = true;
      for (const unwatch of unwatchers) unwatch();
      for (const poller of pollers) window.clearInterval(poller);
    };
  }, [watchedDirectories, scheduleReconcile]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const onFocus = () => scheduleReconcile();
    const onVisibility = () => {
      if (document.visibilityState === "visible") scheduleReconcile();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      if (scanTimerRef.current !== null) window.clearTimeout(scanTimerRef.current);
      scanTimerRef.current = null;
    };
  }, [scheduleReconcile]);

  const setActiveContent = useCallback((content: string) => {
    const id = activeTabIdRef.current;
    const active = tabsRef.current.find((tab) => tab.id === id);
    if (!active || active.needsDiskLoad) return;
    const renderedRevision = active.reloadRevision ?? 0;
    editEpochRef.current.set(id, (editEpochRef.current.get(id) ?? 0) + 1);
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) =>
        t.id === id ? {
          ...t,
          content,
          modified: true,
          isDefaultPlaceholder: false,
          externalChange: (t.reloadRevision ?? 0) !== renderedRevision ? "changed" : t.externalChange,
        } : t
      ),
    }));
  }, []);

  const renameTab = useCallback((id: string, fileName: string) => {
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, fileName, isDefaultPlaceholder: false } : t)),
    }));
  }, []);

  const setTabEncoding = useCallback((id: string, encoding: string) => {
    const tab = tabsRef.current.find((item) => item.id === id);
    if (!tab || tab.needsDiskLoad || tab.encoding === encoding) return;
    editEpochRef.current.set(id, (editEpochRef.current.get(id) ?? 0) + 1);
    patchTab(id, { encoding, modified: true });
  }, [patchTab]);

  const newTab = useCallback(() => {
    const nt = createTab();
    setState((s) => ({ ...s, tabs: [...s.tabs, nt], activeTabId: nt.id }));
  }, []);

  const addTabs = useCallback(
    (loaded: Array<{ filePath: string | null; fileName: string; content: string; encoding: string; eol?: Eol; diskVersion?: string; diskStamp?: string }>) => {
      if (!loaded.length) return;
      setState((s) => {
        const tabs = [...s.tabs];
        let activeTabId = s.activeTabId;
        for (const item of loaded) {
          const existing = item.filePath
            ? tabs.find((t) => t.filePath && isPathAffected(t.filePath, item.filePath!))
            : undefined;
          if (existing) {
            activeTabId = existing.id;
            const index = tabs.indexOf(existing);
            if (existing.modified) {
              const externalChange = existing.externalChange === "changed" || existing.diskVersion !== item.diskVersion
                ? "changed" : undefined;
              tabs[index] = { ...existing, externalChange };
            } else if (existing.diskVersion !== item.diskVersion || existing.needsDiskLoad) {
              tabs[index] = {
                ...existing,
                content: item.content,
                encoding: item.encoding,
                eol: item.eol ?? detectEol(item.content),
                diskVersion: item.diskVersion,
                diskStamp: item.diskStamp,
                modified: false,
                externalChange: undefined,
                needsDiskLoad: false,
                diskLoadError: undefined,
                reloadRevision: (existing.reloadRevision ?? 0) + 1,
              };
            }
          } else {
            const tab: Tab = {
              id: newId(),
              filePath: item.filePath,
              fileName: item.fileName,
              content: item.content,
              modified: false,
              encoding: item.encoding,
              eol: item.eol ?? detectEol(item.content),
              diskVersion: item.diskVersion,
              diskStamp: item.diskStamp,
            };
            tabs.push(tab);
            activeTabId = tab.id;
          }
        }
        return { ...s, tabs, activeTabId };
      });
    },
    []
  );

  const openPaths = useCallback(
    async (paths: string[]) => {
      type LoadedTab = { filePath: string; fileName: string; content: string; encoding: string; eol: Eol; diskVersion: string; diskStamp?: string };
      const loaded: (LoadedTab | null)[] = Array(paths.length).fill(null);
      const failures: string[] = [];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
        while (next < paths.length) {
          const index = next++;
          const path = paths[index];
          try {
            const [{ content, encoding, fingerprint, stamp }, name] = await Promise.all([
              invoke<ReadFileResult>("read_file", { path }),
              invoke<string>("get_file_name", { path }),
            ]);
            loaded[index] = { filePath: path, fileName: name, content, encoding, eol: detectEol(content), diskVersion: fingerprint, diskStamp: stamp ?? undefined };
          } catch (err) {
            failures.push(`${path} — ${fileError(err)}`);
          }
        }
      }));
      const opened = loaded.filter((tab): tab is LoadedTab => tab !== null);
      for (const tab of opened) recordRecent(tab.filePath, tab.fileName);
      addTabs(opened);
      if (failures.length) setFileNotice({ message: t("file.openFailed"), details: failures.join("\n") });
    },
    [addTabs, recordRecent]
  );

  const openFiles = useCallback(
    async (files: File[]) => {
      const loaded: Array<{ filePath: string | null; fileName: string; content: string; encoding: string; eol?: Eol }> = [];
      const failures: string[] = [];
      for (const file of files) {
        try {
          if (file.size > MAX_EDITOR_FILE_BYTES) throw new Error("FILE_TOO_LARGE");
          const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
          if (content.includes("\0")) throw new Error("BINARY_FILE");
          loaded.push({ filePath: null, fileName: file.name, content, encoding: "utf-8", eol: detectEol(content) });
        } catch (err) {
          failures.push(`${file.name} — ${err instanceof TypeError ? t("file.invalidText") : fileError(err)}`);
        }
      }
      addTabs(loaded);
      if (failures.length) setFileNotice({ message: t("file.openFailed"), details: failures.join("\n") });
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
      setFileNotice({ message: t("file.openFailed"), details: fileError(err) });
    }
  }, [openPaths]);

  const finishSave = useCallback((snapshot: Tab, patch: Partial<Tab>) => {
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((tab) => tab.id === snapshot.id ? {
        ...tab,
        ...patch,
        needsDiskLoad: false,
        modified: tab.content !== snapshot.content ||
          tab.encoding !== snapshot.encoding || tab.eol !== snapshot.eol,
      } : tab),
    }));
  }, []);

  const saveTabAs = useCallback(
    async (tab: Tab): Promise<string | null> => {
      if (tab.needsDiskLoad || (tab.filePath && pathIsSaving(tab.filePath))) return null;
      const editEpoch = editEpochRef.current.get(tab.id) ?? 0;
      const outContent = normalizeEol(tab.content, tab.eol ?? defaultEolRef.current);
      try {
        if ("__TAURI_INTERNALS__" in window) {
          if (saveDialogsRef.current.has(tab.id)) return null;
          saveDialogsRef.current.add(tab.id);
          try {
            const selected = await save({ defaultPath: tab.fileName, filters: saveFilters() });
            if (!selected || !tabsRef.current.some((item) => item.id === tab.id)) return null;
            const alreadyOpen = () => tabsRef.current.some((item) =>
              item.id !== tab.id && isPathAffected(item.filePath, selected));
            if (alreadyOpen() || pathIsSaving(selected)) {
              setFileNotice({ message: t("file.destinationOpen"), details: selected });
              return null;
            }
            savingPathsRef.current.add(selected);
            try {
              const expected = isPathAffected(tab.filePath, selected) && tab.diskVersion && !tab.externalChange
                ? tab.diskVersion : await invoke<string | null>("file_fingerprint", { path: selected });
              // A dialog confirms overwriting an existing destination. A known
              // conflict with this same tab still requires the explicit overwrite action.
              if (isPathAffected(tab.filePath, selected) && expected !== null &&
                  (tab.externalChange || !tab.diskVersion)) {
                setFileNotice({ message: t("file.destinationChanged"), details: selected });
                return null;
              }
              if (!tabsRef.current.some((item) => item.id === tab.id)) return null;
              if (alreadyOpen()) {
                setFileNotice({ message: t("file.destinationOpen"), details: selected });
                return null;
              }
              const diskVersion = await invoke<string>("write_file", {
                path: selected, content: outContent, encoding: tab.encoding,
                expectedFingerprint: expected ?? undefined, expectMissing: expected === null,
              });
              const name = selected.split(/[\\/]/).pop() || tab.fileName;
              finishSave(tab, { filePath: selected, fileName: name, diskVersion, diskStamp: undefined, externalChange: undefined });
              return (editEpochRef.current.get(tab.id) ?? 0) === editEpoch ? selected : null;
            } finally {
              savingPathsRef.current.delete(selected);
              scheduleReconcile(parentDirectory(selected));
            }
          } finally {
            saveDialogsRef.current.delete(tab.id);
          }
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
              ],
            });
            const writable = await handle.createWritable();
            await writable.write(outContent);
            await writable.close();
            finishSave(tab, { fileHandle: handle, fileName: handle.name, externalChange: undefined });
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
        finishSave(tab, { fileName: name, externalChange: undefined });
        return null;
      } catch (err) {
        setFileNotice({ message: t("file.saveFailed", { name: tab.fileName }), details: fileError(err) });
        return null;
      }
    },
    [finishSave, pathIsSaving, scheduleReconcile]
  );

  const saveTabData = useCallback(
    async (original: Tab, force = false): Promise<string | null> => {
      const tab = tabsRef.current.find((current) => current.id === original.id);
      if (!tab || tab.needsDiskLoad || saveDialogsRef.current.has(tab.id)) return null;
      const editEpoch = editEpochRef.current.get(tab.id) ?? 0;
      const outContent = normalizeEol(tab.content, tab.eol ?? defaultEolRef.current);
      try {
        if (tab.filePath) {
          if (!force && tab.externalChange === "missing") return await saveTabAs(tab);
          if (pathIsSaving(tab.filePath)) return null;
          if (!force && (tab.externalChange || !tab.diskVersion)) {
            if (!tab.externalChange) patchTab(tab.id, { externalChange: "changed" });
            return null;
          }
          savingPathsRef.current.add(tab.filePath);
          try {
            const diskVersion = await invoke<string>("write_file", {
              path: tab.filePath,
              content: outContent,
              encoding: tab.encoding,
              expectedFingerprint: force ? undefined : tab.diskVersion,
            });
            finishSave(tab, { diskVersion, diskStamp: undefined, externalChange: undefined });
            return (editEpochRef.current.get(tab.id) ?? 0) === editEpoch ? tab.filePath : null;
          } catch (err) {
            if (String(err).includes("FILE_CHANGED_EXTERNALLY")) {
              let missing = false;
              try {
                missing = (await invoke<string | null>("file_fingerprint", { path: tab.filePath })) === null;
              } catch { /* keep the conservative conflict state */ }
              patchTab(tab.id, { externalChange: missing ? "missing" : "changed" });
            }
            throw err;
          } finally {
            savingPathsRef.current.delete(tab.filePath);
            scheduleReconcile(parentDirectory(tab.filePath));
          }
        }
        if (tab.fileHandle) {
          const writable = await tab.fileHandle.createWritable();
          await writable.write(outContent);
          await writable.close();
          finishSave(tab, { externalChange: undefined });
          return null;
        }
        return await saveTabAs(tab);
      } catch (err) {
        setFileNotice({ message: t("file.saveFailed", { name: tab.fileName }), details: fileError(err) });
        return null;
      }
    },
    [finishSave, patchTab, pathIsSaving, saveTabAs, scheduleReconcile]
  );

  const saveActiveAs = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
    if (tab) await saveTabAs(tab);
  }, [saveTabAs]);

  const saveActive = useCallback(async () => {
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab) return;
    await saveTabData(tab);
  }, [state, saveTabData]);

  const reloadTabFromDisk = useCallback(async (id: string) => {
    const snapshot = tabsRef.current.find((tab) => tab.id === id);
    if (!snapshot?.filePath) return;
    let disk: ReadFileResult;
    try {
      disk = await invoke<ReadFileResult>("read_file", { path: snapshot.filePath });
    } catch (err) {
      if (snapshot.needsDiskLoad) {
        const details = fileError(err);
        setState((state) => ({ ...state, tabs: state.tabs.map((tab) =>
          tab.id === id && tab.filePath === snapshot.filePath && tab.needsDiskLoad
            ? { ...tab, diskLoadError: details } : tab) }));
      } else {
        setFileNotice({ message: t("file.openFailed"), details: fileError(err) });
      }
      try {
        if ((await invoke<string | null>("file_fingerprint", { path: snapshot.filePath })) === null) {
          patchTab(id, { externalChange: "missing" });
        }
      } catch { /* leave the current content untouched */ }
      return;
    }
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((tab) => {
        if (tab.id !== id || tab.filePath !== snapshot.filePath) return tab;
        // Do not discard a new edit made while the read was in flight.
        if (tab.content !== snapshot.content || tab.modified !== snapshot.modified ||
            tab.encoding !== snapshot.encoding || tab.eol !== snapshot.eol || tab.diskVersion !== snapshot.diskVersion) {
          return { ...tab, externalChange: "changed" };
        }
        return {
          ...tab,
          content: disk.content,
          encoding: disk.encoding,
          eol: detectEol(disk.content),
          diskVersion: disk.fingerprint,
          modified: false,
          externalChange: undefined,
          needsDiskLoad: false,
          diskLoadError: undefined,
          reloadRevision: (tab.reloadRevision ?? 0) + 1,
          diskStamp: disk.stamp ?? undefined,
        };
      }),
    }));
  }, [patchTab]);

  const overwriteExternalChange = useCallback(async (id: string) => {
    const tab = tabsRef.current.find((current) => current.id === id);
    if (tab?.externalChange !== "changed") return;
    await saveTabData(tab, true);
  }, [saveTabData]);

  // Save every unsaved tab in order. Stops if a Save-As dialog is cancelled
  // (the tab stays `modified`), so the user can retry.
  const saveAll = useCallback(async (): Promise<boolean> => {
    const candidates = tabsRef.current.filter(isTabUnsaved);
    const initialEpochs = new Map(editEpochRef.current);
    const saved = new Map<string, number>();
    const desktop = "__TAURI_INTERNALS__" in window;
    for (const tab of candidates) {
      if (!tabsRef.current.some((current) => current.id === tab.id)) continue;
      const epoch = editEpochRef.current.get(tab.id) ?? 0;
      const savedPath = await saveTabData(tab);
      if (desktop && !savedPath) return false;
      saved.set(tab.id, epoch);
    }
    // React may not have committed the last save's state yet. Compare edit
    // epochs to include any tabs changed or created during the batch.
    const complete = !tabsRef.current.some((tab) => {
      const epoch = editEpochRef.current.get(tab.id) ?? 0;
      if (desktop && saved.has(tab.id)) return saved.get(tab.id) !== epoch;
      return isTabUnsaved(tab) || (desktop && epoch !== (initialEpochs.get(tab.id) ?? 0));
    });
    if (!complete && desktop) setFileNotice({ message: t("file.newEditsDuringSave") });
    return complete;
  }, [saveTabData]);

  const [pendingClose, setPendingClose] = useState<Tab | null>(null);

  const closeTab = useCallback((id: string, remember = true) => {
    editEpochRef.current.delete(id);
    const placeholder = createTab();
    setState((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const closedTabs = remember
        ? [...s.closedTabs, { tab: { ...s.tabs[idx] }, index: idx }].slice(-CLOSED_TABS_MAX)
        : s.closedTabs;
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (tabs.length === 0) {
        return { ...s, tabs: [placeholder], activeTabId: placeholder.id, closedTabs };
      }
      const activeTabId =
        s.activeTabId === id ? tabs[Math.min(idx, tabs.length - 1)].id : s.activeTabId;
      return { ...s, tabs, activeTabId, closedTabs };
    });
  }, []);

  const reopenClosedTab = useCallback(() => {
    const restoredId = newId();
    setState((s) => {
      const entry = s.closedTabs[s.closedTabs.length - 1];
      if (!entry) return s;

      const closedTabs = s.closedTabs.slice(0, -1);
      const existing = entry.tab.filePath
        ? s.tabs.find((tab) => tab.filePath && isPathAffected(tab.filePath, entry.tab.filePath!))
        : undefined;
      if (existing) return { ...s, activeTabId: existing.id, closedTabs };

      const restored: Tab = { ...entry.tab, id: restoredId };
      const placeholder = s.tabs.length === 1 &&
        s.tabs[0].filePath === null &&
        s.tabs[0].content === "" &&
        s.tabs[0].modified === false &&
        s.tabs[0].isDefaultPlaceholder === true;
      if (placeholder) {
        return { ...s, tabs: [restored], activeTabId: restored.id, closedTabs };
      }

      const index = Math.max(0, Math.min(entry.index, s.tabs.length));
      const tabs = [...s.tabs];
      tabs.splice(index, 0, restored);
      return { ...s, tabs, activeTabId: restored.id, closedTabs };
    });
    scheduleReconcile();
  }, [scheduleReconcile]);

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

  const renameOpenFile = useCallback((oldPath: string, newPath: string, newName: string, isDir = false) => {
    const oldPrefix = oldPath.replace(/[\\/]+$/, "");
    const newPrefix = newPath.replace(/[\\/]+$/, "");
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) => {
        if (!t.filePath || !isPathAffected(t.filePath, oldPath, isDir)) return t;
        return {
          ...t,
          filePath: isDir ? newPrefix + t.filePath.slice(oldPrefix.length) : newPath,
          fileName: isDir ? t.fileName : newName,
          // A watcher may observe the old path disappearing during our rename.
          // Keep genuine content conflicts, but clear that transient missing state.
          externalChange: t.externalChange === "missing" ? undefined : t.externalChange,
        };
      }),
    }));
  }, []);

  const closeOpenFile = useCallback((path: string, isDir = false) => {
    for (const tab of tabsRef.current) {
      if (isPathAffected(tab.filePath, path, isDir) && !tab.modified) editEpochRef.current.delete(tab.id);
    }
    setState((s) => {
      const tabs = s.tabs.flatMap((t) => {
        if (!isPathAffected(t.filePath, path, isDir)) return [t];
        // Editing can continue while the native deletion is in flight. Never
        // discard those edits; leave a recoverable tab with the Save-As action.
        return t.modified ? [{ ...t, externalChange: "missing" as const }] : [];
      });
      if (tabs.length === 0) {
        const nt = createTab();
        return { ...s, tabs: [nt], activeTabId: nt.id };
      }
      const activeTabId = tabs.some((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : tabs[0].id;
      return { ...s, tabs, activeTabId };
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
    fileNotice,
    dismissFileNotice: () => setFileNotice(null),
    sessionError,
    sessionLoadFailed: initialSession.blocked,
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
    reloadTabFromDisk,
    overwriteExternalChange,
    saveAll,
    saveTabData,
    persistSessionNow,
    discardUnsavedFromSession,
    resumeSessionBackup,
    closeTab,
    canReopenClosedTab: state.closedTabs.length > 0,
    reopenClosedTab,
    requestClose,
    renameOpenFile,
    closeOpenFile,
    pendingClose,
    cancelPendingClose,
    confirmPendingClose,
  };
}
