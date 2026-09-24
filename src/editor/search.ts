import { StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

export interface SearchResult {
  current: number;
  total: number;
  error?: boolean;
}

export interface Match {
  start: number;
  end: number;
}

export function buildRegex(query: string, caseSensitive: boolean): RegExp | null {
  try {
    return new RegExp(query, caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

export function findMatches(
  text: string,
  query: string,
  caseSensitive: boolean,
  regex: boolean
): { matches: Match[]; error: boolean } {
  if (!query) return { matches: [], error: false };
  if (regex) {
    const re = buildRegex(query, caseSensitive);
    if (!re) return { matches: [], error: true };
    const matches: Match[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length });
      // Zero-length matches (e.g. \b, ^) leave lastIndex stuck; nudge past them.
      if (m[0].length === 0) re.lastIndex++;
    }
    return { matches, error: false };
  }
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: Match[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    matches.push({ start: idx, end: idx + needle.length });
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return { matches, error: false };
}

export interface SearchState {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  current: number;
  matches: Match[];
  error: boolean;
}

const EMPTY: SearchState = {
  query: "",
  caseSensitive: false,
  regex: false,
  current: 0,
  matches: [],
  error: false,
};

export const setSearchParams = StateEffect.define<{
  query: string;
  caseSensitive: boolean;
  regex: boolean;
}>();

export const setCurrentMatch = StateEffect.define<number>();

export const searchField = StateField.define<SearchState>({
  create: () => EMPTY,
  update(value, tr) {
    let next = value;
    let recompute = tr.docChanged;
    for (const e of tr.effects) {
      if (e.is(setSearchParams)) {
        next = { ...next, ...e.value, current: 0 };
        recompute = true;
      } else if (e.is(setCurrentMatch)) {
        next = { ...next, current: e.value };
      }
    }
    if (!recompute) return next;
    if (!next.query) {
      return next.matches.length || next.error || next.current
        ? { ...next, matches: [], error: false, current: 0 }
        : next;
    }
    const { matches, error } = findMatches(
      tr.state.doc.toString(),
      next.query,
      next.caseSensitive,
      next.regex
    );
    const current = matches.length ? Math.min(next.current, matches.length - 1) : 0;
    return { ...next, matches, error, current };
  },
});

// Zero-length matches count towards the total but get no decoration, matching
// how the previous overlay rendered them.
export const searchHighlight = EditorView.decorations.compute([searchField], (state) => {
  const { query, matches, current } = state.field(searchField);
  if (!query || !matches.length) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (let i = 0; i < matches.length; i++) {
    const { start, end } = matches[i];
    if (end <= start) continue;
    const cls = i === current ? "search-match-current" : "search-match";
    ranges.push(Decoration.mark({ class: cls }).range(start, end));
  }
  return Decoration.set(ranges);
});
