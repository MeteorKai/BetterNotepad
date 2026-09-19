import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";

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

export function useFileExplorer() {
  const [isOpen, setIsOpen] = useState(false);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [root, setRoot] = useState<FileNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const readDirEntries = useCallback(async (dirPath: string): Promise<FileNode[]> => {
    const entries = await readDir(dirPath);
    const nodes: FileNode[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      nodes.push({ name: e.name, path: await join(dirPath, e.name), isDir: e.isDirectory });
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

  const toggleDir = useCallback(
    async (node: FileNode) => {
      const willExpand = !expanded.has(node.path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (willExpand) next.add(node.path);
        else next.delete(node.path);
        return next;
      });
      if (willExpand && !node.children) {
        try {
          const children = await readDirEntries(node.path);
          setRoot((r) => updateTreeNode(r, node.path, (n) => ({ ...n, children })));
        } catch (err) {
          console.error("Failed to read dir:", node.path, err);
        }
      }
    },
    [expanded, readDirEntries]
  );

  const refreshDir = useCallback(
    async (dirPath: string) => {
      try {
        const children = await readDirEntries(dirPath);
        setRoot((r) =>
          updateTreeNode(r, dirPath, (n) => ({
            ...n,
            children: children.map((c) => {
              const old = n.children?.find((oc) => oc.path === c.path);
              return old?.isDir && old.children ? { ...c, children: old.children } : c;
            }),
          }))
        );
      } catch (err) {
        console.error("Failed to refresh dir:", dirPath, err);
      }
    },
    [readDirEntries]
  );

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

  const deleteNode = useCallback(
    async (node: FileNode): Promise<boolean> => {
      try {
        await invoke("delete_file", { path: node.path });
        await refreshDir(parentDir(node.path));
        return true;
      } catch (err) {
        console.error("Failed to delete:", node.path, err);
        return false;
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
      if (!node.children) {
        try {
          const children = await readDirEntries(dirPath);
          setRoot((r) => updateTreeNode(r, dirPath, (n) => ({ ...n, children })));
        } catch (err) {
          console.error("Failed to read dir:", dirPath, err);
          return;
        }
      }
      setExpanded((prev) => {
        if (prev.has(dirPath)) return prev;
        const next = new Set(prev);
        next.add(dirPath);
        return next;
      });
    },
    [root, readDirEntries]
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
