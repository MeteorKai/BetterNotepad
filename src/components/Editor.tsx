import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useState,
} from "react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  keymap,
  lineNumbers,
  placeholder,
  type Command,
} from "@codemirror/view";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { bracketMatching as bracketMatchingExtension } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import EditorContextMenu from "./EditorContextMenu";
import { getLanguageLoader } from "../editor/languages";
import { cmHighlighting } from "../editor/theme";
import { t } from "../i18n";
import {
  buildRegex,
  searchField,
  searchHighlight,
  setCurrentMatch,
  setSearchParams,
  type Match,
  type SearchResult,
} from "../editor/search";

export type { SearchResult, Match };

// Above this many lines syntax highlighting is disabled entirely.
export const LARGE_FILE_LINE_THRESHOLD = 10000;

// Counting lines without splitting avoids allocating one string per line, and
// bailing out early keeps this cheap on very large files.
export function exceedsLineThreshold(text: string, threshold: number): boolean {
  let lines = 1;
  let idx = text.indexOf("\n");
  while (idx !== -1) {
    if (++lines > threshold) return true;
    idx = text.indexOf("\n", idx + 1);
  }
  return false;
}

// Undo history, cursor and scroll are kept per tab id outside the component, so
// switching tabs and remounting the editor preserves them.
interface TabEditorState {
  state: EditorState;
  scrollTop: number;
  scrollLeft: number;
}
const editorStates = new Map<string, TabEditorState>();

export function clearEditorHistory(id: string): void {
  editorStates.delete(id);
}

// Shared by every mount. A tab's EditorState is cached in `editorStates` and
// reused by later mounts, so its extension tree may reference compartments from
// an earlier instance; only shared compartments can be reconfigured through
// those reused states.
const compartments = {
  wrap: new Compartment(),
  language: new Compartment(),
  tabSize: new Compartment(),
  bracketMatching: new Compartment(),
};

export interface EditorHandle {
  undo: () => void;
  redo: () => void;
  getSelection: () => string;
  find: (query: string, caseSensitive: boolean, regex: boolean) => SearchResult;
  findNext: () => SearchResult;
  findPrev: () => SearchResult;
  replace: (replacement: string) => SearchResult;
  replaceAll: (replacement: string) => SearchResult;
  clearSearch: () => void;
  focusEditor: () => void;
  goToLine: (line: number) => void;
}

interface EditorProps {
  content: string;
  onChange: (value: string) => void;
  onCursorChange: (line: number, col: number, total: number) => void;
  onSelectionChange?: (count: number) => void;
  fontSize: number;
  fontFamily: string;
  tabWidth: number;
  insertSpaces: boolean;
  language: string | null;
  wrap: boolean;
  bracketMatching: boolean;
  tabId: string;
}

const LINE_COMMENT_BY_LANG: Record<string, string> = {
  python: "#",
  ruby: "#",
  yaml: "#",
  toml: "#",
  bash: "#",
  javascript: "//",
  typescript: "//",
  tsx: "//",
  jsx: "//",
  php: "//",
  rust: "//",
  go: "//",
  java: "//",
  c: "//",
  cpp: "//",
  csharp: "//",
  kotlin: "//",
  swift: "//",
  scss: "//",
  sql: "--",
  ini: ";",
};

const BLOCK_COMMENT_BY_LANG: Record<string, [string, string]> = {
  markup: ["<!--", "-->"],
  css: ["/*", "*/"],
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Marks transactions that mirror a change to the `content` prop from outside.
// Their effect must not be echoed back through onChange, which would mark the
// tab as modified.
const externalSync = Annotation.define<boolean>();

const Editor = forwardRef<EditorHandle, EditorProps>(
  ({ content, onChange, onCursorChange, onSelectionChange, fontSize, fontFamily, tabWidth, insertSpaces, language, wrap, bracketMatching, tabId }, ref) => {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const lastEmittedRef = useRef(content);
    const largeFileRef = useRef(false);
    const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);

    // Live props for the imperative handlers, which are created once.
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onCursorChangeRef = useRef(onCursorChange);
    onCursorChangeRef.current = onCursorChange;
    const onSelectionChangeRef = useRef(onSelectionChange);
    onSelectionChangeRef.current = onSelectionChange;
    const languageRef = useRef(language);
    languageRef.current = language;
    const indentUnitRef = useRef("\t");
    indentUnitRef.current = insertSpaces ? " ".repeat(tabWidth) : "\t";

    const reportState = useCallback((state: EditorState) => {
      const sel = state.selection.main;
      const line = state.doc.lineAt(sel.head);
      onCursorChangeRef.current(line.number, sel.head - line.from + 1, state.doc.lines);
      onSelectionChangeRef.current?.(sel.to - sel.from);
    }, []);

    // Loads syntax highlighting for the current language, unless the file is
    // above the large-file threshold. Async loads are dropped if the language
    // changed or the editor unmounted while they were in flight.
    const applyLanguage = useCallback(
      (view: EditorView) => {
        const name = largeFileRef.current ? null : languageRef.current;
        const loader = getLanguageLoader(name);
        if (!loader) {
          view.dispatch({ effects: compartments.language.reconfigure([]) });
          return () => {};
        }
        let cancelled = false;
        loader()
          .then((extension) => {
            if (cancelled || viewRef.current !== view) return;
            view.dispatch({ effects: compartments.language.reconfigure(extension) });
          })
          .catch(() => {});
        return () => {
          cancelled = true;
        };
      },
      [compartments]
    );

    // Cancels the previous load before starting the next one, so a slow loader
    // can never apply a language the editor has already moved on from.
    const languageCleanupRef = useRef<() => void>(() => {});
    const reloadLanguage = useCallback(
      (view: EditorView) => {
        languageCleanupRef.current();
        languageCleanupRef.current = applyLanguage(view);
      },
      [applyLanguage]
    );

    useLayoutEffect(() => {
      const saved = editorStates.get(tabId);
      // Reuse the stored state only while it still matches the incoming
      // content; a mismatch (e.g. the tab was reloaded from disk) starts fresh.
      const reuse = !!saved && saved.state.doc.toString() === content;
      const state =
        reuse && saved
          ? saved.state
          : EditorState.create({
              doc: content,
              extensions: [
                history({ newGroupDelay: 0 }),
                drawSelection(),
                closeBrackets(),
                compartments.bracketMatching.of(
                  bracketMatching
                    ? [
                        bracketMatchingExtension({
                          brackets: "()[]{}",
                          maxScanDistance: 1e4,
                          afterCursor: true,
                        }),
                      ]
                    : []
                ),
                EditorView.contentAttributes.of({
                  spellcheck: "false",
                  autocorrect: "off",
                  autocapitalize: "off",
                }),
                placeholder(t("editor.placeholder")),
                cmHighlighting,
                searchField,
                searchHighlight,
                EditorView.updateListener.of((update) => {
                  if (update.docChanged) {
                    const value = update.state.doc.toString();
                    lastEmittedRef.current = value;
                    if (!update.transactions.some((tr) => tr.annotation(externalSync))) {
                      onChangeRef.current(value);
                    }
                    const large = update.state.doc.lines > LARGE_FILE_LINE_THRESHOLD;
                    if (large !== largeFileRef.current) {
                      largeFileRef.current = large;
                      reloadLanguage(update.view);
                    }
                  }
                  if (update.docChanged || update.selectionSet) {
                    reportState(update.state);
                  }
                }),
                compartments.tabSize.of(EditorState.tabSize.of(tabWidth)),
                lineNumbers(),
                compartments.wrap.of(wrap ? [EditorView.lineWrapping] : []),
                compartments.language.of([]),
                keymap.of([
                  { key: "Enter", run: insertNewlineIndent },
                  { key: "Tab", run: insertTab },
                  { key: "Mod-/", run: toggleLineComment },
                  // Consumed so the default binding cannot insert a blank line;
                  // the app's global shortcut still runs the file.
                  { key: "Mod-Enter", run: () => true },
                  ...closeBracketsKeymap,
                  ...defaultKeymap,
                  ...historyKeymap,
                ]),
                EditorView.inputHandler.of(handleInput),
              ],
            });

      const view = new EditorView({ state, parent: hostRef.current! });
      viewRef.current = view;
      lastEmittedRef.current = content;
      largeFileRef.current = state.doc.lines > LARGE_FILE_LINE_THRESHOLD;
      reloadLanguage(view);

      if (reuse && saved) {
        view.scrollDOM.scrollTop = saved.scrollTop;
        view.scrollDOM.scrollLeft = saved.scrollLeft;
      }
      reportState(view.state);

      return () => {
        languageCleanupRef.current();
        editorStates.set(tabId, {
          state: view.state,
          scrollTop: view.scrollDOM.scrollTop,
          scrollLeft: view.scrollDOM.scrollLeft,
        });
        view.destroy();
        viewRef.current = null;
      };
      // The editor is remounted per tab (App keys it by tab id), so tabId is the
      // only dependency; prop changes are handled by the effects below.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabId]);

    // Push genuinely external content changes into the document. Changes the
    // user typed are already in the document and are skipped by identity.
    useEffect(() => {
      const view = viewRef.current;
      if (!view || content === lastEmittedRef.current) return;
      lastEmittedRef.current = content;
      if (view.state.doc.toString() === content) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        annotations: [externalSync.of(true), Transaction.addToHistory.of(false)],
      });
    }, [content]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: [
          compartments.wrap.reconfigure(wrap ? [EditorView.lineWrapping] : []),
          compartments.tabSize.reconfigure(EditorState.tabSize.of(tabWidth)),
          compartments.bracketMatching.reconfigure(
            bracketMatching
              ? [
                  bracketMatchingExtension({
                    brackets: "()[]{}",
                    maxScanDistance: 1e4,
                    afterCursor: true,
                  }),
                ]
              : []
          ),
        ],
      });
    }, [wrap, tabWidth, bracketMatching, compartments]);

    useEffect(() => {
      const view = viewRef.current;
      if (view) reloadLanguage(view);
    }, [language, reloadLanguage]);

    // Enter carries over the current line's indentation, deepening one level
    // after an unclosed `{`, `[`, `(`, or `:`.
    const insertNewlineIndent: Command = (view) => {
      const { state } = view;
      const { from, to } = state.selection.main;
      const line = state.doc.lineAt(from);
      const linePrefix = state.sliceDoc(line.from, from);
      const baseIndent = linePrefix.match(/^[ \t]*/)?.[0] ?? "";
      const extra = /[{(:[]\s*$/.test(linePrefix) ? indentUnitRef.current : "";
      const newIndent = baseIndent + extra;
      view.dispatch({
        changes: { from, to, insert: "\n" + newIndent },
        selection: { anchor: from + 1 + newIndent.length },
        userEvent: "input",
        scrollIntoView: true,
      });
      return true;
    };

    // Typing `}` on an otherwise-blank line outdents it by one indent unit.
    const handleInput = useCallback(
      (view: EditorView, from: number, to: number, text: string): boolean => {
        if (text !== "}") return false;
        const { state } = view;
        // An existing `}` under the caret is skipped over by closeBrackets.
        if (state.sliceDoc(from, from + 1) === "}") return false;
        const line = state.doc.lineAt(from);
        const linePrefix = state.sliceDoc(line.from, from);
        if (!/^\s+$/.test(linePrefix)) return false;
        const unit = indentUnitRef.current;
        if (!linePrefix.startsWith(unit)) return false;
        const newPrefix = linePrefix.slice(unit.length);
        view.dispatch({
          changes: { from: line.from, to, insert: newPrefix + text },
          selection: { anchor: line.from + newPrefix.length + 1 },
          userEvent: "input.type",
        });
        return true;
      },
      []
    );

    const insertTab: Command = (view) => {
      const { from, to } = view.state.selection.main;
      const unit = indentUnitRef.current;
      view.dispatch({
        changes: { from, to, insert: unit },
        selection: { anchor: from + unit.length },
        userEvent: "input",
        scrollIntoView: true,
      });
      return true;
    };

    const toggleLineComment: Command = (view) => {
      const { state } = view;
      const { from, to } = state.selection.main;
      const lang = languageRef.current ?? "";
      const block = BLOCK_COMMENT_BY_LANG[lang];
      const prefix = LINE_COMMENT_BY_LANG[lang];
      if (!prefix && !block) return false;

      // Languages with only block comments: wrap/unwrap the selection.
      if (!prefix) {
        if (from === to) return false;
        const sel = state.sliceDoc(from, to);
        const [open, close] = block;
        const wrapped = sel.startsWith(open) && sel.endsWith(close);
        const insert = wrapped ? sel.slice(open.length, sel.length - close.length) : open + sel + close;
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from, head: from + insert.length },
          userEvent: "input",
        });
        return true;
      }

      // Line comments: toggle the prefix across the affected lines.
      const lineStart = state.doc.lineAt(from).from;
      const lineEnd = state.doc.lineAt(Math.max(from, to - 1)).to;
      const lines = state.sliceDoc(lineStart, lineEnd).split("\n");
      const nonEmpty = lines.filter((l) => l.trim().length > 0);
      const allCommented =
        nonEmpty.length > 0 && nonEmpty.every((l) => l.trimStart().startsWith(prefix));

      const newLines = lines.map((line) => {
        if (line.trim().length === 0) return line;
        if (allCommented) {
          return line.replace(new RegExp("^(\\s*)" + escapeRegExp(prefix) + " ?"), "$1");
        }
        return line.replace(/^(\s*)/, "$1" + prefix + " ");
      });

      const insert = newLines.join("\n");
      view.dispatch({
        changes: { from: lineStart, to: lineEnd, insert },
        selection: { anchor: lineStart, head: lineStart + insert.length },
        userEvent: "input",
      });
      return true;
    };

    const selectMatch = useCallback((view: EditorView, index: number, list: Match[]) => {
      const m = list[index];
      if (!m) return;
      view.dispatch({
        selection: { anchor: m.start, head: m.end },
        effects: EditorView.scrollIntoView(m.start, { y: "center" }),
      });
    }, []);

    const goToLine = useCallback((line: number) => {
      const view = viewRef.current;
      if (!view) return;
      const { doc } = view.state;
      const target = Math.max(0, Math.min(line - 1, doc.lines - 1));
      const pos = doc.line(target + 1).from;
      view.focus();
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
    }, []);

    const copySelection = useCallback(() => {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      if (from === to) return;
      const text = view.state.sliceDoc(from, to);
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      } else if (document.execCommand) {
        view.focus();
        document.execCommand("copy");
      }
    }, []);

    const cutSelection = useCallback(() => {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      if (from === to) return;
      copySelection();
      view.dispatch({
        changes: { from, to, insert: "" },
        selection: { anchor: from },
        userEvent: "delete.cut",
      });
      view.focus();
    }, [copySelection]);

    const pasteAtCursor = useCallback(async () => {
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      if (navigator.clipboard?.readText) {
        try {
          const text = await navigator.clipboard.readText();
          // The clipboard read is async; the tab may have been switched away.
          if (viewRef.current !== view) return;
          view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste" });
          return;
        } catch {
          // fall through to execCommand
        }
      }
      if (document.execCommand) document.execCommand("paste");
    }, []);

    const selectAll = useCallback(() => {
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        undo: () => {
          const view = viewRef.current;
          if (view) undo(view);
        },
        redo: () => {
          const view = viewRef.current;
          if (view) redo(view);
        },
        getSelection: () => {
          const view = viewRef.current;
          if (!view) return "";
          const { from, to } = view.state.selection.main;
          return view.state.sliceDoc(from, to);
        },
        find: (query, caseSensitive, regex) => {
          const view = viewRef.current;
          if (!view) return { current: 0, total: 0 };
          view.dispatch({ effects: setSearchParams.of({ query, caseSensitive, regex }) });
          const { matches, error } = view.state.field(searchField);
          if (matches.length) selectMatch(view, 0, matches);
          return { current: 0, total: matches.length, error };
        },
        findNext: () => {
          const view = viewRef.current;
          if (!view) return { current: 0, total: 0 };
          const { matches, current, error } = view.state.field(searchField);
          if (!matches.length) return { current: 0, total: 0, error };
          const next = (current + 1) % matches.length;
          view.dispatch({ effects: setCurrentMatch.of(next) });
          selectMatch(view, next, matches);
          return { current: next, total: matches.length, error };
        },
        findPrev: () => {
          const view = viewRef.current;
          if (!view) return { current: 0, total: 0 };
          const { matches, current, error } = view.state.field(searchField);
          if (!matches.length) return { current: 0, total: 0, error };
          const next = (current - 1 + matches.length) % matches.length;
          view.dispatch({ effects: setCurrentMatch.of(next) });
          selectMatch(view, next, matches);
          return { current: next, total: matches.length, error };
        },
        replace: (replacement) => {
          const view = viewRef.current;
          if (!view) return { current: 0, total: 0 };
          const search = view.state.field(searchField);
          const { query, caseSensitive, regex, matches, current, error } = search;
          if (!query || !matches.length) return { current: 0, total: 0, error };
          const { start, end } = matches[current];
          // Regex mode expands capture-group references ($1, $&, ...). The
          // matched span matches the pattern exactly, so a replace on that span
          // yields the substitution for the current match only.
          const replacedPart = regex
            ? view.state
                .sliceDoc(start, end)
                .replace(new RegExp(query, caseSensitive ? "" : "i"), replacement)
            : replacement;
          view.dispatch({
            changes: { from: start, to: end, insert: replacedPart },
            userEvent: "input.replace",
          });
          const after = view.state.field(searchField);
          const pos = start + replacedPart.length;
          let idx = after.matches.findIndex((m) => m.start >= pos);
          if (idx === -1) idx = after.matches.length ? 0 : -1;
          const next = idx === -1 ? 0 : idx;
          view.dispatch({ effects: setCurrentMatch.of(next) });
          if (after.matches.length) selectMatch(view, next, after.matches);
          return { current: next, total: after.matches.length, error: after.error };
        },
        replaceAll: (replacement) => {
          const view = viewRef.current;
          if (!view) return { current: 0, total: 0 };
          const search = view.state.field(searchField);
          const { query, caseSensitive, regex, matches, error } = search;
          if (!query || !matches.length) return { current: 0, total: 0, error };
          const src = view.state.doc.toString();
          let next: string;
          if (regex) {
            const re = buildRegex(query, caseSensitive);
            if (!re) return { current: 0, total: 0, error: true };
            next = src.replace(re, replacement);
          } else {
            next = src;
            for (let i = matches.length - 1; i >= 0; i--) {
              const { start, end } = matches[i];
              next = next.substring(0, start) + replacement + next.substring(end);
            }
          }
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: next },
            userEvent: "input.replace.all",
          });
          const after = view.state.field(searchField);
          return { current: 0, total: after.matches.length, error: after.error };
        },
        clearSearch: () => {
          const view = viewRef.current;
          if (view) {
            view.dispatch({
              effects: setSearchParams.of({ query: "", caseSensitive: false, regex: false }),
            });
          }
        },
        focusEditor: () => {
          viewRef.current?.focus();
        },
        goToLine,
      }),
      [applyLanguage, selectMatch, goToLine]
    );

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      const view = viewRef.current;
      const hasSelection = !!view && view.state.selection.main.from !== view.state.selection.main.to;
      setMenu({ x: e.clientX, y: e.clientY, hasSelection });
    }, []);

    return (
      <div className="h-full w-full relative" onContextMenu={handleContextMenu}>
        <div
          ref={hostRef}
          className="h-full w-full bg-editor overflow-hidden"
          style={{ fontSize: `${fontSize}px`, fontFamily }}
        />
        {menu && (
          <EditorContextMenu
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
            items={[
              { label: t("menu.cut"), shortcut: "Ctrl+X", disabled: !menu.hasSelection, onSelect: cutSelection },
              { label: t("menu.copy"), shortcut: "Ctrl+C", disabled: !menu.hasSelection, onSelect: copySelection },
              { label: t("menu.paste"), shortcut: "Ctrl+V", onSelect: pasteAtCursor },
              { label: t("menu.selectAll"), shortcut: "Ctrl+A", disabled: false, onSelect: selectAll },
            ]}
          />
        )}
      </div>
    );
  }
);

Editor.displayName = "Editor";

export default Editor;
