import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

// Keys match the language ids produced by detectLanguage() in App.tsx.
const LOADERS: Record<string, () => Promise<Extension>> = {
  python: async () => (await import("@codemirror/lang-python")).python(),
  php: async () => (await import("@codemirror/lang-php")).php(),
  javascript: async () => (await import("@codemirror/lang-javascript")).javascript(),
  typescript: async () =>
    (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
  jsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  tsx: async () =>
    (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true }),
  rust: async () => (await import("@codemirror/lang-rust")).rust(),
  go: async () => (await import("@codemirror/lang-go")).go(),
  java: async () => (await import("@codemirror/lang-java")).java(),
  c: async () => (await import("@codemirror/lang-cpp")).cpp(),
  cpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
  markup: async () => (await import("@codemirror/lang-html")).html(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  scss: async () => (await import("@codemirror/lang-sass")).sass({ indented: false }),
  json: async () => (await import("@codemirror/lang-json")).json(),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  sql: async () => (await import("@codemirror/lang-sql")).sql(),
  // No official CM6 package: CodeMirror 5 stream modes ported by legacy-modes.
  toml: async () =>
    StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml),
  bash: async () =>
    StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell),
  ruby: async () =>
    StreamLanguage.define((await import("@codemirror/legacy-modes/mode/ruby")).ruby),
  swift: async () =>
    StreamLanguage.define((await import("@codemirror/legacy-modes/mode/swift")).swift),
  kotlin: async () =>
    StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).kotlin),
  csharp: async () =>
    StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).csharp),
  ini: async () =>
    StreamLanguage.define((await import("@codemirror/legacy-modes/mode/properties")).properties),
  diff: async () =>
    StreamLanguage.define((await import("@codemirror/legacy-modes/mode/diff")).diff),
};

export function getLanguageLoader(language: string | null): (() => Promise<Extension>) | null {
  return language ? LOADERS[language] ?? null : null;
}
