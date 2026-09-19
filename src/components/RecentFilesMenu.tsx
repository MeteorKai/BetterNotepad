import { useEffect, useRef, useState } from "react";
import type { RecentFile } from "../hooks/useTabs";
import { t } from "../i18n";

interface RecentFilesMenuProps {
  recent: RecentFile[];
  onOpen: (path: string) => void;
  onClear: () => void;
}

export default function RecentFilesMenu({ recent, onOpen, onClear }: RecentFilesMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={t("recent.title")}
        aria-haspopup="true"
        aria-expanded={open}
        className="px-2.5 py-1.5 rounded-md hover:bg-hover text-sub hover:text-ink transition-colors duration-150 flex items-center justify-center focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 bg-panel border border-line rounded-lg shadow-card py-1 z-50 min-w-[240px]">
          {recent.length === 0 ? (
            <div className="px-3 py-2 text-xs text-faint">{t("recent.empty")}</div>
          ) : (
            <>
              {recent.map((r) => (
                <button
                  key={r.path}
                  onClick={() => {
                    onOpen(r.path);
                    setOpen(false);
                  }}
                  className="block w-full text-left px-3 py-1.5 hover:bg-hover transition-colors"
                >
                  <span className="block text-xs text-ink truncate">{r.name}</span>
                  <span className="block text-[10px] text-faint truncate">{r.path}</span>
                </button>
              ))}
              <div className="border-t border-line mt-1 pt-1">
                <button
                  onClick={() => {
                    onClear();
                    setOpen(false);
                  }}
                  className="block w-full text-left px-3 py-1.5 text-xs text-danger hover:bg-hover transition-colors"
                >
                  {t("recent.clear")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
