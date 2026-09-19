import { useEffect, useRef, useState } from "react";
import { ENCODING_OPTIONS } from "../hooks/useTabs";
import { t } from "../i18n";

interface StatusBarProps {
  line: number;
  col: number;
  totalLines: number;
  fontSize: number;
  tabWidth: number;
  insertSpaces: boolean;
  largeFile: boolean;
  selectionLen: number;
  encoding: string;
  onChangeEncoding: (encoding: string) => void;
}

export default function StatusBar({
  line,
  col,
  totalLines,
  fontSize,
  tabWidth,
  insertSpaces,
  largeFile,
  selectionLen,
  encoding,
  onChangeEncoding,
}: StatusBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (buttonRef.current && !buttonRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const currentLabel = ENCODING_OPTIONS.find((o) => o.id === encoding)?.label ?? encoding;

  return (
    <div className="h-7 bg-panel-2 flex items-center justify-between px-4 text-xs text-sub border-t border-line-soft">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-accent opacity-70" />
          {t("status.line", { line, col })}
        </span>
        {selectionLen > 0 && (
          <span className="text-accent">{t("status.selected", { count: selectionLen })}</span>
        )}
        <span>{t("status.lines", { count: totalLines })}</span>
      </div>
      <div className="flex items-center gap-4">
        <div className="relative">
          <button
            ref={buttonRef}
            onClick={() => setMenuOpen((o) => !o)}
            title={t("status.encodingTitle")}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-sub hover:text-ink hover:bg-hover transition-colors"
          >
            {currentLabel}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {menuOpen && (
            <div className="absolute right-0 bottom-full mb-1 bg-panel border border-line rounded-lg shadow-card py-1 z-50 min-w-[170px]">
              {ENCODING_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  onClick={() => {
                    onChangeEncoding(o.id);
                    setMenuOpen(false);
                  }}
                  className={`block w-full text-left px-3 py-1.5 hover:bg-hover transition-colors ${
                    o.id === encoding ? "text-accent" : "text-ink"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <span title={insertSpaces ? t("status.indentSpaces") : t("status.indentTabs")}>
          {insertSpaces
            ? t("status.spaces", { size: tabWidth })
            : t("status.tabWidth", { size: tabWidth })}
        </span>
        {largeFile && (
          <span className="text-warn" title={t("status.highlightTitle")}>
            {t("status.highlightOff")}
          </span>
        )}
        <span>{fontSize}px</span>
      </div>
    </div>
  );
}
