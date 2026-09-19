import { useEffect, useRef, useState } from "react";
import type { Tab } from "../hooks/useTabs";
import { t } from "../i18n";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, fileName: string) => void;
  onMoveTab: (id: string, beforeId?: string) => void;
}

// HTML5 drag-and-drop is unreliable inside Tauri's WebView2 (dragstart often
// never fires), so tab reordering is implemented with pointer events instead.
interface DragState {
  id: string;
  pointerId: number;
  x: number;
  y: number;
  moved: boolean;
}

export default function TabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNew,
  onRename,
  onMoveTab,
}: TabBarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const lastTargetIndexRef = useRef(-1);
  const tabElsRef = useRef(new Map<string, HTMLDivElement>());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    if (renamingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renamingId]);

  const startRename = (tab: Tab) => {
    setRenamingId(tab.id);
    setDraft(tab.fileName);
  };

  const commitRename = () => {
    if (skipBlurRef.current) {
      skipBlurRef.current = false;
      return;
    }
    if (renamingId) {
      const name = draft.trim();
      if (name) onRename(renamingId, name);
      setRenamingId(null);
    }
  };

  const cancelRename = () => {
    skipBlurRef.current = true;
    setRenamingId(null);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      commitRename();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      cancelRename();
    }
  };

  const endDrag = () => {
    suppressClickRef.current = dragRef.current?.moved ?? false;
    dragRef.current = null;
    lastTargetIndexRef.current = -1;
    setDragId(null);
  };

  const handlePointerDown = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Don't hijack the close button or the inline rename input.
    if ((e.target as HTMLElement).closest("button, input")) return;
    dragRef.current = { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    lastTargetIndexRef.current = tabs.findIndex((t) => t.id === id);
    setDragId(id);
    e.preventDefault();
  };

  useEffect(() => {
    if (!dragId) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.moved && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) d.moved = true;
      if (!d.moved) return;

      const list = tabsRef.current;
      const dragIdx = list.findIndex((t) => t.id === d.id);
      if (dragIdx === -1) return;
      // The pointer's desired insertion point: first tab whose center is past the cursor.
      const rects = list.map((t) => tabElsRef.current.get(t.id)?.getBoundingClientRect());
      let desired = rects.findIndex((r) => r && e.clientX < r.left + r.width / 2);
      if (desired === -1) desired = rects.length;
      // Final index once the dragged tab is removed: drop its own position out.
      const finalIdx = desired - (dragIdx < desired ? 1 : 0);
      if (finalIdx === dragIdx || finalIdx === lastTargetIndexRef.current) return;
      lastTargetIndexRef.current = finalIdx;
      const rest = list.filter((t) => t.id !== d.id);
      onMoveTab(d.id, rest[finalIdx]?.id);
    };
    const onUp = (e: PointerEvent) => {
      if (dragRef.current && e.pointerId === dragRef.current.pointerId) endDrag();
    };
    const onCancel = () => endDrag();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [dragId, onMoveTab]);

  return (
    <div className="h-10 bg-panel flex items-end border-b border-line-soft overflow-x-auto">
      <div className="flex items-end min-h-full">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const renaming = tab.id === renamingId;
          const dragging = dragId === tab.id;
          const cls = [
            "group flex items-center gap-2 px-3 h-full rounded-t-lg text-sm whitespace-nowrap select-none cursor-pointer border-t-2",
            active ? "bg-editor border-t-accent text-ink" : "bg-transparent border-t-transparent text-faint hover:bg-hover hover:text-ink",
            dragging ? "opacity-40" : "",
          ].join(" ");
          return (
            <div
              key={tab.id}
              ref={(el) => {
                if (el) tabElsRef.current.set(tab.id, el);
                else tabElsRef.current.delete(tab.id);
              }}
              onPointerDown={handlePointerDown(tab.id)}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                onActivate(tab.id);
              }}
              onDoubleClick={() => startRename(tab)}
              title={tab.filePath ?? tab.fileName}
              className={cls}
            >
              {renaming ? (
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={handleRenameKeyDown}
                  onBlur={commitRename}
                  onDoubleClick={(e) => e.stopPropagation()}
                  className="w-[140px] bg-editor text-ink px-1 py-0.5 rounded border border-accent outline-none text-sm"
                />
              ) : (
                <>
                  <span className="max-w-[160px] truncate">{tab.fileName}</span>
                  {tab.modified && <span className="w-2 h-2 rounded-full bg-accent shrink-0" />}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(tab.id);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    className="w-4 h-4 rounded flex items-center justify-center text-faint hover:bg-hover hover:text-ink shrink-0"
                    title={t("tab.close")}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          );
        })}
        <button
          onClick={onNew}
          className="h-full px-2 text-faint hover:text-ink hover:bg-hover flex items-center shrink-0"
          title={t("tab.newTitle")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
