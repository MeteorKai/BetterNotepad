import { useCallback, useEffect, useRef, useState } from "react";
import { pathKey, type FileNode } from "../hooks/useFileExplorer";
import type { RecentFile } from "../hooks/useTabs";
import { t } from "../i18n";

interface FileExplorerProps {
  root: FileNode | null;
  expanded: Set<string>;
  activePath: string | null;
  width: number;
  recent: RecentFile[];
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
  if (idx === 2 && /^[a-z]:/i.test(p)) return p.slice(0, 3);
  return idx < 0 ? p : p.slice(0, idx) || p.slice(0, 1);
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
  const isActive = activePath !== null && pathKey(node.path) === pathKey(activePath);
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
  recent,
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

  const expandRef = useRef(onExpandTo);
  expandRef.current = onExpandTo;
  const rootPath = root?.path;
  // Only reveal on navigation. Watcher refreshes or a manual collapse should
  // not reopen the active file's folder.
  useEffect(() => {
    if (!activePath || !rootPath) return;
    let cancelled = false;
    let frame: number | undefined;
    void expandRef.current(activePath).then(() => {
      if (cancelled) return;
      frame = requestAnimationFrame(() => {
        const key = pathKey(activePath);
        const item = Array.from(document.querySelectorAll<HTMLElement>("[data-path]")).find(
          (node) => node.dataset.path !== undefined && pathKey(node.dataset.path) === key
        );
        item?.scrollIntoView({ block: "nearest" });
      });
    });
    return () => {
      cancelled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [activePath, rootPath]);

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
    <aside className="app-sidebar flex flex-col" style={{ width }} aria-label={t("explorer.title")}>
      <div className="sidebar-heading">
        <span>{t("workspace.files")}</span>
        <button
          onClick={onClose}
          className="app-tool"
          title={t("explorer.closeTitle")}
          aria-label={t("explorer.closeTitle")}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16m8-11-3 3 3 3" />
          </svg>
        </button>
      </div>
      <div className="sidebar-content flex-1 min-h-0 overflow-auto">
        {!root ? (
          <div className="sidebar-empty">
            <div className="sidebar-folder-mark">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                <path d="M2 10h20" />
              </svg>
            </div>
            <p className="sidebar-empty-title">{t("explorer.noFolder")}</p>
            <p className="sidebar-empty-hint">{t("workspace.folderHint")}</p>
            <button type="button" className="sidebar-open" onClick={onOpenFolder}>
              {t("explorer.openFolder")}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14m-6-6 6 6-6 6" />
              </svg>
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
        <div className="sidebar-recent">
          <h2>{t("recent.title")}</h2>
          {recent.length ? (
            <ul>
              {recent.slice(0, 5).map((file) => (
                <li key={file.path}>
                  <button type="button" title={file.path} onClick={() => onOpenFile(file.path)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zm0 0v6h6" />
                    </svg>
                    <span className="truncate">{file.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p>{t("recent.empty")}</p>}
        </div>
      </div>
      <div className="sidebar-footer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 21h8m-4-4v4" />
        </svg>
        <span className="truncate">{t("workspace.local")}</span>
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
