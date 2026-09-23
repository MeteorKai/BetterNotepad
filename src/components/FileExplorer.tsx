import { useCallback, useEffect, useState } from "react";
import type { FileNode } from "../hooks/useFileExplorer";
import { t } from "../i18n";

interface FileExplorerProps {
  root: FileNode | null;
  expanded: Set<string>;
  activePath: string | null;
  width: number;
  onOpenFolder: () => void;
  onToggleDir: (node: FileNode) => void;
  onExpandTo: (path: string) => Promise<void>;
  onOpenFile: (path: string) => void;
  onRename: (node: FileNode, newName: string) => void;
  onDelete: (node: FileNode) => void;
  onCreate: (parentPath: string, name: string, isDir: boolean) => Promise<string | null>;
  onClose: () => void;
}

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  activePath: string | null;
  renamingPath: string | null;
  renameDraft: string;
  onRenameDraft: (v: string) => void;
  onRenameCommit: (node: FileNode) => void;
  onRenameCancel: () => void;
  creating: { parentPath: string; isDir: boolean } | null;
  createDraft: string;
  onCreateDraft: (v: string) => void;
  onCreateCommit: () => void;
  onCreateCancel: () => void;
  onToggleDir: (node: FileNode) => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
}

function parentDir(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx === -1 ? p : p.slice(0, idx);
}

function TreeNode({
  node,
  depth,
  expanded,
  activePath,
  renamingPath,
  renameDraft,
  onRenameDraft,
  onRenameCommit,
  onRenameCancel,
  creating,
  createDraft,
  onCreateDraft,
  onCreateCommit,
  onCreateCancel,
  onToggleDir,
  onOpenFile,
  onContextMenu,
}: TreeNodeProps) {
  const indent = 8 + depth * 14;
  const isActive = node.path === activePath;
  const isRenaming = node.path === renamingPath;

  if (node.isDir) {
    const isExpanded = expanded.has(node.path);
    return (
      <div>
        <button
          onClick={() => onToggleDir(node)}
          onContextMenu={(e) => onContextMenu(e, node)}
          data-path={node.path}
          className="w-[calc(100%_-_8px)] mx-1 rounded-lg flex items-center gap-1.5 py-1.5 pr-2 text-sm text-ink hover:bg-hover text-left whitespace-nowrap transition-colors"
          style={{ paddingLeft: indent }}
          title={node.path}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={"text-sub shrink-0 " + (isExpanded ? "rotate-90 transition-transform" : "transition-transform")}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-warn shrink-0">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          {isRenaming ? (
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => onRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onRenameCommit(node);
                else if (e.key === "Escape") onRenameCancel();
              }}
              onBlur={() => onRenameCommit(node)}
              onClick={(e) => e.stopPropagation()}
              onFocus={(e) => e.target.select()}
              className="flex-1 min-w-0 bg-elevated text-ink px-1 py-0.5 rounded border border-accent outline-none text-sm"
            />
          ) : (
            <span className="truncate">{node.name}</span>
          )}
        </button>
        {isExpanded &&
          node.children?.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              activePath={activePath}
              renamingPath={renamingPath}
              renameDraft={renameDraft}
              onRenameDraft={onRenameDraft}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
              creating={creating}
              createDraft={createDraft}
              onCreateDraft={onCreateDraft}
              onCreateCommit={onCreateCommit}
              onCreateCancel={onCreateCancel}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
            />
          ))}
        {creating?.parentPath === node.path && (
          <div
            className="flex items-center gap-1.5 py-1 pr-2 text-sm"
            style={{ paddingLeft: 8 + (depth + 1) * 14 }}
          >
            {creating.isDir ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-warn shrink-0">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-faint shrink-0">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            )}
            <input
              autoFocus
              value={createDraft}
              onChange={(e) => onCreateDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onCreateCommit();
                else if (e.key === "Escape") onCreateCancel();
              }}
              onBlur={() => onCreateCommit()}
              className="flex-1 min-w-0 bg-elevated text-ink px-1 py-0.5 rounded border border-accent outline-none text-sm"
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={() => onOpenFile(node.path)}
      onContextMenu={(e) => onContextMenu(e, node)}
      data-path={node.path}
      className={
        isActive
          ? "w-[calc(100%_-_8px)] mx-1 rounded-lg flex items-center gap-1.5 py-1.5 pr-2 text-sm bg-accent-soft text-ink text-left whitespace-nowrap transition-colors"
          : "w-[calc(100%_-_8px)] mx-1 rounded-lg flex items-center gap-1.5 py-1.5 pr-2 text-sm text-sub hover:bg-hover hover:text-ink text-left whitespace-nowrap transition-colors"
      }
      style={{ paddingLeft: indent + 20 }}
      title={node.path}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-faint shrink-0">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      {isRenaming ? (
        <input
          value={renameDraft}
          onChange={(e) => onRenameDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRenameCommit(node);
            else if (e.key === "Escape") onRenameCancel();
          }}
          onBlur={() => onRenameCommit(node)}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 min-w-0 bg-elevated text-ink px-1 py-0.5 rounded border border-accent outline-none text-sm"
        />
      ) : (
        <span className="truncate">{node.name}</span>
      )}
    </button>
  );
}

export default function FileExplorer({
  root,
  expanded,
  activePath,
  width,
  onOpenFolder,
  onToggleDir,
  onExpandTo,
  onOpenFile,
  onRename,
  onDelete,
  onCreate,
  onClose,
}: FileExplorerProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; node: FileNode } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [creating, setCreating] = useState<{ parentPath: string; isDir: boolean } | null>(null);
  const [createDraft, setCreateDraft] = useState("");

  // Reveal the active file: expand its ancestors, then scroll it into view.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!activePath || !root) return;
      await onExpandTo(activePath);
      if (cancelled) return;
      const el = Array.from(document.querySelectorAll("[data-path]")).find(
        (n) => n.getAttribute("data-path") === activePath
      );
      el?.scrollIntoView({ block: "nearest" });
    })();
    return () => {
      cancelled = true;
    };
  }, [activePath, root, onExpandTo]);

  useEffect(() => {
    if (!menu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-tree-menu]")) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const startRename = useCallback((node: FileNode) => {
    setMenu(null);
    setRenamingPath(node.path);
    setRenameDraft(node.name);
  }, []);

  const commitRename = useCallback(
    (node: FileNode) => {
      const name = renameDraft.trim();
      if (name && name !== node.name) onRename(node, name);
      setRenamingPath(null);
    },
    [renameDraft, onRename]
  );

  const cancelRename = useCallback(() => setRenamingPath(null), []);

  const startCreate = useCallback(
    (isDir: boolean) => {
      const node = menu?.node;
      if (!node) return;
      const parentPath = node.isDir ? node.path : parentDir(node.path);
      setMenu(null);
      setCreating({ parentPath, isDir });
      setCreateDraft("");
      if (node.isDir) void onExpandTo(node.path);
    },
    [menu, onExpandTo]
  );

  const commitCreate = useCallback(async () => {
    const c = creating;
    if (!c) return;
    const name = createDraft.trim();
    setCreating(null);
    if (name) {
      const newPath = await onCreate(c.parentPath, name, c.isDir);
      if (newPath && !c.isDir) onOpenFile(newPath);
    }
  }, [creating, createDraft, onCreate, onOpenFile]);

  const cancelCreate = useCallback(() => setCreating(null), []);

  const handleDelete = useCallback(
    (node: FileNode) => {
      setMenu(null);
      if (confirm(t("explorer.confirmDelete", { name: node.name }))) onDelete(node);
    },
    [onDelete]
  );

  return (
    <aside className="shrink-0 bg-panel border-r border-line-soft flex flex-col" style={{ width }}>
      <div className="h-10 flex items-center justify-between px-3 border-b border-line-soft">
        <span className="text-xs font-semibold uppercase tracking-wider text-faint">{t("explorer.title")}</span>
        <button
          onClick={onClose}
          className="w-5 h-5 rounded flex items-center justify-center text-faint hover:text-ink hover:bg-hover transition-colors"
          title={t("explorer.closeTitle")}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-auto py-1">
        {!root ? (
          <div className="px-3 py-8 flex flex-col items-center gap-3 text-center">
            <div className="w-10 h-10 rounded-xl bg-accent-soft text-accent flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <p className="text-sm text-sub">{t("explorer.noFolder")}</p>
            <button
              onClick={onOpenFolder}
              className="px-3 py-1.5 rounded-lg text-sm font-medium text-accent-ink bg-accent hover:bg-accent-strong transition-colors shadow-sm"
            >
              {t("explorer.openFolder")}
            </button>
          </div>
        ) : (
          <TreeNode
            node={root}
            depth={0}
            expanded={expanded}
            activePath={activePath}
            renamingPath={renamingPath}
            renameDraft={renameDraft}
            onRenameDraft={setRenameDraft}
            onRenameCommit={commitRename}
            onRenameCancel={cancelRename}
            creating={creating}
            createDraft={createDraft}
            onCreateDraft={setCreateDraft}
            onCreateCommit={commitCreate}
            onCreateCancel={cancelCreate}
            onToggleDir={onToggleDir}
            onOpenFile={onOpenFile}
            onContextMenu={handleContextMenu}
          />
        )}
      </div>

      {menu && (
        <div
          data-tree-menu
          className="fixed z-[60] bg-elevated border border-line rounded-lg shadow-xl py-1 min-w-[140px] select-none"
          style={{
            left: Math.min(menu.x, window.innerWidth - 160),
            top: Math.min(menu.y, window.innerHeight - 100),
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            onClick={() => startCreate(false)}
            className="w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-hover transition-colors"
          >
            {t("explorer.newFile")}
          </button>
          <button
            onClick={() => startCreate(true)}
            className="w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-hover transition-colors"
          >
            {t("explorer.newFolder")}
          </button>
          <button
            onClick={() => startRename(menu.node)}
            className="w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-hover transition-colors"
          >
            {t("explorer.rename")}
          </button>
          <button
            onClick={() => handleDelete(menu.node)}
            className="w-full text-left px-3 py-1.5 text-sm text-danger hover:bg-hover transition-colors"
          >
            {t("explorer.delete")}
          </button>
        </div>
      )}
    </aside>
  );
}
