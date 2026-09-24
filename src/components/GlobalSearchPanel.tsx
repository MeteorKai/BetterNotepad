import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";

interface SearchMatch {
  line: number;
  text: string;
}

interface SearchFileResult {
  path: string;
  name: string;
  matches: SearchMatch[];
}

interface GlobalSearchPanelProps {
  root: string | null;
  onOpenResult: (path: string, line: number) => void;
  onClose: () => void;
}

function highlightLine(text: string, query: string) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="bg-match-current text-ink rounded-sm">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}

export default function GlobalSearchPanel({ root, onOpenResult, onClose }: GlobalSearchPanelProps) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchFileResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);

  const doSearch = useCallback(
    async (q: string, cs: boolean, requestId: number) => {
      if (requestId !== requestIdRef.current) return;
      if (!root || !q.trim()) {
        if (requestId === requestIdRef.current) {
          setResults(null);
          setSearching(false);
          setError(null);
        }
        return;
      }
      try {
        const res = await invoke<SearchFileResult[]>("search_in_files", {
          root,
          query: q,
          caseSensitive: cs,
        });
        if (requestId === requestIdRef.current) setResults(res);
      } catch (err) {
        if (requestId === requestIdRef.current) {
          setResults(null);
          setError(String(err));
        }
      } finally {
        if (requestId === requestIdRef.current) setSearching(false);
      }
    },
    [root]
  );

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setResults(null);
    setError(null);
    setSearching(Boolean(root && query.trim()));
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void doSearch(query, caseSensitive, requestId);
    }, 400);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      requestIdRef.current++;
    };
  }, [root, query, caseSensitive, doSearch]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const total = results?.reduce((n, r) => n + r.matches.length, 0) ?? 0;

  return (
    <div className="border-b border-line-soft bg-panel">
      <div className="flex items-center gap-2 px-3 py-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          placeholder={root ? t("globalSearch.placeholder") : t("search.openFolderFirst")}
          className="flex-1 bg-editor border border-line rounded-md px-3 py-1.5 text-sm text-ink outline-none focus:border-accent placeholder:text-placeholder"
        />
        <button
          onClick={() => setCaseSensitive((c) => !c)}
          title={t("search.caseSensitive")}
          className={`px-2 py-1 rounded-md text-xs transition-colors ${
            caseSensitive ? "accent-chip" : "text-sub hover:bg-hover"
          }`}
        >
          Aa
        </button>
        <span className="text-xs text-sub whitespace-nowrap">
          {searching
            ? t("globalSearch.searching")
            : total
              ? t("globalSearch.results", { count: total, files: results?.length ?? 0 })
              : query
                ? t("globalSearch.noResults")
                : ""}
        </span>
        <button
          onClick={onClose}
          title={t("common.closeEsc")}
          className="px-2 py-1 rounded-md text-sub hover:bg-hover hover:text-ink"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      {error && <div className="px-3 pb-2 text-xs text-danger">{error}</div>}
      {root && results && results.length > 0 && (
        <div className="max-h-[45vh] overflow-y-auto px-3 pb-2">
          {results.map((r) => (
            <div key={r.path} className="mb-2">
              <div className="text-xs text-faint font-mono truncate mb-0.5">{r.path}</div>
              {r.matches.map((m) => (
                <button
                  key={m.line}
                  onClick={() => onOpenResult(r.path, m.line)}
                  className="block w-full text-left px-2 py-0.5 rounded hover:bg-hover group"
                >
                  <span className="inline-block w-10 text-right mr-2 text-faint text-xs select-none">
                    {m.line}
                  </span>
                  <span className="text-xs text-ink font-mono break-all">{highlightLine(m.text, query)}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
