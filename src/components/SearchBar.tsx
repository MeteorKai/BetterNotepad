import { useState, useCallback, useEffect, useRef } from "react";
import type { EditorHandle, SearchResult } from "./Editor";
import { t } from "../i18n";

interface SearchBarProps {
  editorRef: React.RefObject<EditorHandle | null>;
  onClose: () => void;
  showReplace: boolean;
  onToggleReplace: () => void;
}

function CtrlButton({
  onClick,
  title,
  active = false,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={
        active
          ? "px-2 py-1 rounded accent-chip flex items-center"
          : "px-2 py-1 rounded hover:bg-hover text-sub hover:text-ink transition-colors flex items-center"
      }
    >
      {children}
    </button>
  );
}

export default function SearchBar({
  editorRef,
  onClose,
  showReplace,
  onToggleReplace,
}: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [matchInfo, setMatchInfo] = useState<SearchResult>({ current: 0, total: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  const find = useCallback(
    (q: string, cs: boolean, rgx: boolean) => {
      const res = editorRef.current?.find(q, cs, rgx);
      if (res) setMatchInfo(res);
    },
    [editorRef]
  );

  useEffect(() => {
    inputRef.current?.focus();
    const sel = editorRef.current?.getSelection();
    if (sel) {
      setQuery(sel);
      find(sel, false, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleQueryChange = useCallback(
    (q: string) => {
      setQuery(q);
      find(q, caseSensitive, regex);
    },
    [find, caseSensitive, regex]
  );

  const toggleCase = useCallback(() => {
    const next = !caseSensitive;
    setCaseSensitive(next);
    find(query, next, regex);
  }, [caseSensitive, query, find, regex]);

  const toggleRegex = useCallback(() => {
    const next = !regex;
    setRegex(next);
    find(query, caseSensitive, next);
  }, [regex, query, caseSensitive, find]);

  const findNext = useCallback(() => {
    const res = editorRef.current?.findNext();
    if (res) setMatchInfo(res);
  }, [editorRef]);

  const findPrev = useCallback(() => {
    const res = editorRef.current?.findPrev();
    if (res) setMatchInfo(res);
  }, [editorRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F3") {
        e.preventDefault();
        if (e.shiftKey) findPrev();
        else findNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [findNext, findPrev]);

  const doReplace = useCallback(() => {
    const res = editorRef.current?.replace(replace);
    if (res) setMatchInfo(res);
  }, [editorRef, replace]);

  const doReplaceAll = useCallback(() => {
    const res = editorRef.current?.replaceAll(replace);
    if (res) setMatchInfo(res);
  }, [editorRef, replace]);

  const handleFindKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) findPrev();
        else findNext();
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [findNext, findPrev, onClose]
  );

  const handleReplaceKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doReplace();
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [doReplace, onClose]
  );

  const status = !query
    ? ""
    : matchInfo.error
      ? t("search.invalidRegex")
      : matchInfo.total > 0
        ? `${matchInfo.current + 1}/${matchInfo.total}`
        : t("search.noResults");

  return (
    <div className="relative bg-panel border-b border-line-soft px-4 py-2 flex flex-col gap-2">
      <div className="pointer-events-none absolute inset-0 pattern-dots" />
      <div className="relative flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-faint shrink-0">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          onKeyDown={handleFindKeyDown}
          placeholder={t("search.placeholder")}
          className="bg-editor text-ink px-3 py-1 rounded-md border border-line outline-none focus:border-accent text-sm w-64 transition-colors"
        />
        <CtrlButton onClick={toggleCase} title={t("search.caseSensitive")} active={caseSensitive}>
          <span className="text-xs font-medium">Aa</span>
        </CtrlButton>
        <CtrlButton onClick={toggleRegex} title={t("search.regexTitle")} active={regex}>
          <span className="text-xs font-mono font-semibold">.*</span>
        </CtrlButton>
        <CtrlButton onClick={findPrev} title={t("search.prevTitle")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </CtrlButton>
        <CtrlButton onClick={findNext} title={t("search.nextTitle")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </CtrlButton>
        <span
          className={
            matchInfo.error || (query && matchInfo.total === 0)
              ? "text-xs text-danger min-w-[64px] text-center tabular-nums"
              : "text-xs text-faint min-w-[64px] text-center tabular-nums"
          }
        >
          {status}
        </span>
        <CtrlButton onClick={onToggleReplace} title={t("search.toggleReplace")} active={showReplace}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </CtrlButton>
        <CtrlButton onClick={onClose} title={t("common.closeEsc")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </CtrlButton>
      </div>
      {showReplace && (
        <div className="relative flex items-center gap-2 pl-6">
          <input
            type="text"
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            onKeyDown={handleReplaceKeyDown}
            placeholder={t("search.replacePlaceholder")}
            className="bg-editor text-ink px-3 py-1 rounded-md border border-line outline-none focus:border-accent text-sm w-64 transition-colors"
          />
          <button
            onClick={doReplace}
            className="px-2 py-1 rounded accent-chip text-xs"
          >
            {t("search.replace")}
          </button>
          <button
            onClick={doReplaceAll}
            className="px-2 py-1 rounded accent-chip text-xs"
          >
            {t("search.all")}
          </button>
        </div>
      )}
    </div>
  );
}
