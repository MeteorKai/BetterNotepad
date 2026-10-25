import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir, watchImmediate } from "@tauri-apps/plugin-fs";
import { sep } from "@tauri-apps/api/path";

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
}

const SKIP_DIRS = new Set([".git", "node_modules"]);

function parentDir(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx === -1 ? p : p.slice(0, idx);
}

function findNode(node: FileNode | null, path: string): FileNode | null {
  if (!node) return null;
  if (node.path === path) return node;
  if (node.children) {
    for (const c of node.children) {
      const r = findNode(c, path);
      if (r) return r;
    }
  }
  return null;
}

function isUnderPath(filePath: string, dirPath: string): boolean {
  if (!filePath.startsWith(dirPath)) return false;
  return (
    filePath.length === dirPath.length ||
    filePath[dirPath.length] === "/" ||
    filePath[dirPath.length] === "\\"
  );
}

function visibleDirectories(node: FileNode | null, expanded: Set<string>): string[] {
  if (!node) return [];
  const directories = [node.path];
  if (expanded.has(node.path)) {
    for (const child of node.children ?? []) {
      if (child.isDir && expanded.has(child.path)) {
        directories.push(...visibleDirectories(child, expanded));
      }
    }
  }
  return directories;
}

export function useFileExplorer() {
  const [isOpen, setIsOpen] = useState(false);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [root, setRoot] = useState<FileNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const latestReadsRef = useRef(new Map<string, symbol>());

  const readDirEntries = useCallback(async (dirPath: string): Promise<FileNode[]> => {
    const entries = await readDir(dirPath);
    const nodes: FileNode[] = [];
    const separator = sep();
    const prefix = dirPath.endsWith(separator) || (separator === "\\" && dirPath.endsWith("/"))
      ? dirPath
      : dirPath + separator;
    for (const e of entries) {
      if (e.isDirectory && SKIP_DIRS.has(e.name)) continue;
      nodes.push({ name: e.name, path: prefix + e.name, isDir: e.isDirectory });
    }
    nodes.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
    );
    return nodes;
  }, []);

  const openFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;
      const dir = selected as string;
      latestReadsRef.current.clear();
      const entries = await readDirEntries(dir);
      const name = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
      setFolderPath(dir);
      setRoot({ name, path: dir, isDir: true, children: entries });
      setExpanded(new Set([dir]));
      setIsOpen(true);
    } catch (err) {
      console.error("Failed to open folder:", err);
    }
  }, [readDirEntries]);

  const refreshDir = useCallback(
    async (dirPath: string): Promise<boolean> => {
      const request = Symbol();
      latestReadsRef.current.set(dirPath, request);
      try {
        const children = await readDirEntries(dirPath);
        if (latestReadsRef.current.get(dirPath) !== request) return false;
        setRoot((r) =>
          updateTreeNode(r, dirPath, (n) => {
            const oldChildren = new Map((n.children ?? []).map((c) => [c.path, c]));
            return {
              ...n,
              children: children.map((c) => {
                const old = oldChildren.get(c.path);
                return old?.isDir && old.children ? { ...c, children: old.children } : c;
              }),
            };
          })
        );
        return true;
      } catch (err) {
        console.error("Failed to refresh dir:", dirPath, err);
        return false;
      }
    },
    [readDirEntries]
  );

  const toggleDir = useCallback(
    async (node: FileNode) => {
      const willExpand = !expanded.has(node.path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (willExpand) next.add(node.path);
        else next.delete(node.path);
        return next;
      });
      // Collapsed directories are not watched, so their cached entries may be stale.
      if (willExpand) await refreshDir(node.path);
    },
    [expanded, refreshDir]
  );

  const watchedDirectories = isOpen ? visibleDirectories(root, expanded).sort().join("\0") : "";

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window) || !watchedDirectories) return;
    let disposed = false;
    const directories = watchedDirectories.split("\0");
    const timers = new Map<string, number>();
    const unwatchers: Array<() => void> = [];
    const pollers: number[] = [];
    const schedule = (directory: string) => {
      if (disposed) return;
      if (timers.has(directory)) return;
      timers.set(directory, window.setTimeout(() => {
        timers.delete(directory);
        if (!disposed) void refreshDir(directory);
      }, 250));
    };
    for (const directory of directories) {
      void watchImmediate(directory, (event) => {
        if (typeof event.type === "object" && (
          "access" in event.type || ("modify" in event.type && event.type.modify.kind === "data")
        )) return;
        schedule(directory);
      }, { recursive: false }).then((unwatch) => {
        if (disposed) unwatch();
        else {
          unwatchers.push(unwatch);
          schedule(directory); // Catch changes made while the watcher was registering.
        }
      }).catch((err) => {
        if (disposed) return;
        console.error("Failed to watch directory; polling instead:", directory, err);
        pollers.push(window.setInterval(() => schedule(directory), 2000));
        schedule(directory);
      });
    }
    const reconcile = () => directories.forEach(schedule);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      for (const timer of timers.values()) window.clearTimeout(timer);
      for (const unwatch of unwatchers) unwatch();
      for (const poller of pollers) window.clearInterval(poller);
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [watchedDirectories, refreshDir]);

  const renameNode = useCallback(
    async (node: FileNode, newName: string): Promise<string | null> => {
      try {
        const newPath = await invoke<string>("rename_file", { path: node.path, newName });
        await refreshDir(parentDir(node.path));
        return newPath;
      } catch (err) {
        console.error("Failed to rename:", node.path, err);
        return null;
      }
    },
    [refreshDir]
  );

  // Returns null on success, or the backend's error message. Deletion is a move
  // to the Recycle Bin and can genuinely fail (e.g. a network share without
  // one); the caller needs the reason to tell the user why nothing happened.
  const deleteNode = useCallback(
    async (node: FileNode): Promise<string | null> => {
      try {
        await invoke("delete_file", { path: node.path });
        await refreshDir(parentDir(node.path));
        return null;
      } catch (err) {
        console.error("Failed to delete:", node.path, err);
        return String(err);
      }
    },
    [refreshDir]
  );

  const createNode = useCallback(
    async (parentPath: string, name: string, isDir: boolean): Promise<string | null> => {
      try {
        const newPath = await invoke<string>(isDir ? "create_folder" : "create_file", {
          parent: parentPath,
          name,
        });
        await refreshDir(parentPath);
        return newPath;
      } catch (err) {
        console.error("Failed to create:", parentPath, name, err);
        return null;
      }
    },
    [refreshDir]
  );

  const ensureExpanded = useCallback(
    async (dirPath: string) => {
      const node = findNode(root, dirPath);
      if (!node) return;
      if (!node.children || !expanded.has(dirPath)) {
        if (!(await refreshDir(dirPath))) return;
      }
      setExpanded((prev) => {
        if (prev.has(dirPath)) return prev;
        const next = new Set(prev);
        next.add(dirPath);
        return next;
      });
    },
    [root, expanded, refreshDir]
  );

  const expandTo = useCallback(
    async (filePath: string) => {
      if (!folderPath || !isUnderPath(filePath, folderPath)) return;
      const ancestors: string[] = [];
      let cur = parentDir(filePath);
      while (cur && cur.length >= folderPath.length) {
        ancestors.unshift(cur);
        if (cur === folderPath) break;
        cur = parentDir(cur);
      }
      for (const dir of ancestors) {
        await ensureExpanded(dir);
      }
    },
    [folderPath, ensureExpanded]
  );

  const toggle = useCallback(() => setIsOpen((p) => !p), []);

  return {
    isOpen,
    toggle,
    folderPath,
    root,
    expanded,
    openFolder,
    toggleDir,
    renameNode,
    deleteNode,
    createNode,
    expandTo,
  };
}

function updateTreeNode(
  node: FileNode | null,
  path: string,
  updater: (n: FileNode) => FileNode
): FileNode | null {
  if (!node) return null;
  if (node.path === path) return updater(node);
  if (!node.children) return node;
  return {
    ...node,
    children: node.children
      .map((c) => updateTreeNode(c, path, updater))
      .filter((c): c is FileNode => c !== null),
  };
}
