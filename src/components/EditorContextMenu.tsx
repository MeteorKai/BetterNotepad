import { useEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface EditorContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export default function EditorContextMenu({ x, y, items, onClose }: EditorContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  // Measure after render so the menu stays inside the viewport.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPos({
      left: Math.max(0, Math.min(x, window.innerWidth - w - 8)),
      top: Math.max(0, Math.min(y, window.innerHeight - h - 8)),
    });
    setReady(true);
  }, [x, y]);

  return (
    <div
      ref={ref}
      className={
        ready
          ? "fixed z-50 bg-elevated border border-line rounded-lg shadow-xl py-1 min-w-[160px] select-none"
          : "fixed invisible bg-elevated border border-line rounded-lg shadow-xl py-1 min-w-[160px] select-none"
      }
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          disabled={item.disabled}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
          className="w-full text-left px-3 py-1.5 text-sm flex items-center justify-between gap-6 text-ink hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-default transition-colors"
        >
          <span>{item.label}</span>
          {item.shortcut && <span className="text-faint text-xs">{item.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}
