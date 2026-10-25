import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { EditorSelection, Transaction } = require("@codemirror/state");
const cmView = require("@codemirror/view");
const { indentUnit } = require("@codemirror/language");
const compiled = ts.transpileModule(fs.readFileSync(new URL("../src/components/Editor.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Real EditorState, commands, keymap and history; only React mounting and the
// DOM view are replaced so the actual Editor bindings can run without a browser.
function harness(doc, selection, settings = {}) {
  let slots = [], cursor = 0, effects = [], pending = [], view;
  const changes = [];
  const api = {};
  const props = {
    content: doc, tabId: "test", reloadRevision: 0, tabWidth: 4, insertSpaces: true,
    language: null, wrap: false, bracketMatching: false, fontSize: 14, fontFamily: "monospace",
    onChange(value) { props.content = value; changes.push(value); },
    onCursorChange() {}, onLargeFileChange() {}, ...settings,
  };
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const effect = (fn, deps) => {
    const i = cursor++;
    if (!sameDeps(slots[i], deps)) pending.push(() => { effects[i]?.(); effects[i] = fn(); });
    slots[i] = deps;
  };
  const react = {
    forwardRef: (render) => render,
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], (value) => { slots[i] = value; }]; },
    useCallback: (fn) => fn,
    useLayoutEffect: effect, useEffect: effect,
    useImperativeHandle: (ref, create) => { ref.current = create(); },
  };
  function HeadlessView({ state }) {
    view = { state, scrollDOM: { scrollTop: 0, scrollLeft: 0 }, hasFocus: false, focus() {}, destroy() {} };
    const current = view;
    current.dispatch = (...specs) => {
      const tr = specs.length === 1 && specs[0] instanceof Transaction ? specs[0] : current.state.update(...specs);
      current.state = tr.state;
      for (const listener of current.state.facet(cmView.EditorView.updateListener)) {
        listener({ view: current, state: current.state, docChanged: tr.docChanged, selectionSet: !!tr.selection, transactions: [tr] });
      }
    };
    return current;
  }
  Object.setPrototypeOf(HeadlessView, cmView.EditorView);
  const mockRequire = (id) => {
    if (id === "react") return react;
    if (id === "@codemirror/view") return { ...cmView, EditorView: HeadlessView };
    if (id === "./EditorContextMenu") return { __esModule: true, default: () => null };
    if (id === "../editor/languages") return { getLanguageLoader: () => null };
    if (id === "../editor/theme") return { cmHighlighting: [] };
    if (id === "../i18n") return { t: (key) => key };
    if (id === "../editor/search") return { searchField: [], searchHighlight: [] };
    return require(id);
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(mockRequire, module, module.exports);
  const h = {
    changes,
    get state() { return view.state; },
    render(patch = {}) {
      Object.assign(props, patch); cursor = 0; pending = [];
      module.exports.default(props, api);
      for (const run of pending) run();
    },
    select(anchor, head = anchor) { view.dispatch({ selection: EditorSelection.single(anchor, head) }); },
    tab(shift = false) {
      const binding = view.state.facet(cmView.keymap).flat().find((entry) => entry.key === (shift ? "Shift-Tab" : "Tab"));
      const command = shift && !binding ? view.state.facet(cmView.keymap).flat().find((entry) => entry.key === "Tab")?.shift : binding?.run;
      return command?.(view) ?? false;
    },
    undo() { api.current.undo(); },
    redo() { api.current.redo(); },
    remount(patch = {}) {
      for (const cleanup of effects) cleanup?.();
      slots = []; effects = [];
      h.render(patch);
    },
  };
  h.render();
  h.select(selection.anchor, selection.head ?? selection.anchor);
  return h;
}

test("Tab indents selected lines without deleting text and keeps the selection", () => {
  const h = harness("first\nsecond\nthird", { anchor: 1, head: 10 });
  assert.equal(h.tab(), true);
  assert.equal(h.state.doc.toString(), "    first\n    second\nthird");
  assert.equal(h.state.selection.main.empty, false);
  assert.equal(h.changes.length, 1);
  assert.equal(h.state.selection.main.anchor, 5);
  assert.equal(h.state.selection.main.head, 18);
});

test("a partial single-line selection indents the whole line without replacing it", () => {
  const h = harness("hello world", { anchor: 6, head: 11 });
  h.tab();
  assert.equal(h.state.doc.toString(), "    hello world");
  assert.equal(h.state.sliceDoc(h.state.selection.main.from, h.state.selection.main.to), "world");
});

test("ending a selection at the next line's start does not indent that line", () => {
  const h = harness("one\ntwo\nthree", { anchor: 0, head: 4 });
  h.tab();
  assert.equal(h.state.doc.toString(), "    one\ntwo\nthree");
});

test("reverse selections stay selected and support repeated indentation", () => {
  const h = harness("one\ntwo", { anchor: 7, head: 0 });
  h.tab(); h.tab();
  assert.equal(h.state.doc.toString(), "        one\n        two");
  assert.ok(h.state.selection.main.anchor > h.state.selection.main.head);
  assert.equal(h.state.selection.main.empty, false);
});

test("Shift+Tab removes one indentation level and never deletes unindented text", () => {
  const h = harness("    one\n  two\nthree", { anchor: 0, head: 19 });
  assert.equal(h.tab(true), true);
  assert.equal(h.state.doc.toString(), "one\ntwo\nthree");
  h.tab(true);
  assert.equal(h.state.doc.toString(), "one\ntwo\nthree");
});

test("Tab and Shift+Tab use configured tab characters and work on blank lines", () => {
  const h = harness("one\n\ntwo", { anchor: 0, head: 8 }, { insertSpaces: false });
  h.tab();
  assert.equal(h.state.doc.toString(), "\tone\n\t\n\ttwo");
  h.tab(true);
  assert.equal(h.state.doc.toString(), "one\n\ntwo");
});

test("without a selection Tab still inserts at the caret and Shift+Tab outdents", () => {
  const h = harness("ab", { anchor: 1 }, { tabWidth: 2 });
  h.tab();
  assert.equal(h.state.doc.toString(), "a  b");
  assert.equal(h.state.selection.main.head, 3);
  h.select(0); h.tab(); h.tab(true);
  assert.equal(h.state.doc.toString(), "a  b");
});

test("space width and tab/space changes take effect without reopening the tab", () => {
  const h = harness("one\ntwo", { anchor: 0, head: 7 }, { tabWidth: 2 });
  h.tab();
  assert.equal(h.state.doc.toString(), "  one\n  two");
  h.render({ tabWidth: 3 }); h.tab();
  assert.equal(h.state.doc.toString(), "     one\n     two");
  h.render({ insertSpaces: false }); h.tab();
  assert.equal(h.state.doc.toString(), "\t     one\n\t     two");
  assert.equal(h.state.facet(indentUnit), "\t");
});

test("reopening cached editor state uses current indentation settings", () => {
  const h = harness("ab", { anchor: 1 }, { insertSpaces: false });
  h.remount({ insertSpaces: true, tabWidth: 3 });
  h.tab();
  assert.equal(h.state.doc.toString(), "a   b");
  h.select(0, h.state.doc.length); h.tab();
  assert.equal(h.state.doc.toString(), "   a   b");
});

test("block indentation and outdent can each be undone and redone in one step", () => {
  const h = harness("one\ntwo", { anchor: 0, head: 7 });
  h.tab();
  h.undo(); assert.equal(h.state.doc.toString(), "one\ntwo");
  h.redo(); assert.equal(h.state.doc.toString(), "    one\n    two");
  h.tab(true); assert.equal(h.state.doc.toString(), "one\ntwo");
  h.undo(); assert.equal(h.state.doc.toString(), "    one\n    two");
});
