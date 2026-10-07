import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const compiled = new Map(["src/hooks/useFileExplorer.ts", "src/components/GlobalSearchPanel.tsx", "src/i18n/index.ts"].map((file) => [file,
  ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
  }).outputText,
]));
const folder = "D:\\work";
const entry = (name, isDirectory = false) => ({ name, isDirectory });
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

// Native I/O and time are controlled; actual hook effects and cleanup run.
function harness(kind = "explorer", response = null) {
  const slots = [];
  const effects = [];
  const timers = new Map();
  const intervals = new Map();
  const watchers = new Map();
  const listeners = new Map();
  const directories = new Map([[folder, []]]);
  const calls = { reads: [], watches: [], unwatches: [], searches: [] };
  let cursor = 0;
  let timerId = 0;
  let selection = folder;
  let readOverride;
  let watchFailure = false;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (update) => { slots[i] = typeof update === "function" ? update(slots[i]) : update; }];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { fn, deps };
      return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) {
        const previous = slots[i];
        slots[i] = { deps };
        effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  const window = {
    __TAURI_INTERNALS__: {},
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval(fn) { const id = ++timerId; intervals.set(id, fn); return id; },
    clearInterval: (id) => intervals.delete(id),
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  const document = { visibilityState: "visible", addEventListener: window.addEventListener, removeEventListener: window.removeEventListener };
  const modules = new Map();
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const module = { exports: {} };
    const mockRequire = (id) => {
      if (id === "react") return react;
      if (id === "react/jsx-runtime") return require(id);
      if (id === "../i18n") return load("src/i18n/index.ts");
      if (id === "@tauri-apps/api/core") return { invoke: async (_, args) => { calls.searches.push(args); return response; } };
      if (id === "@tauri-apps/plugin-dialog") return { open: async () => selection };
      if (id === "@tauri-apps/api/path") return { sep: () => "\\" };
      if (id === "@tauri-apps/plugin-fs") return {
        readDir: async (dir) => {
          calls.reads.push(dir);
          if (readOverride) return readOverride(dir);
          if (!directories.has(dir)) throw new Error(`Missing directory: ${dir}`);
          return directories.get(dir);
        },
        watchImmediate: async (dir, callback, options) => {
          calls.watches.push({ dir, options });
          if (watchFailure) throw new Error("Watcher unavailable");
          watchers.set(dir, callback);
          return () => { calls.unwatches.push(dir); watchers.delete(dir); };
        },
      };
      throw new Error(`Unexpected import: ${id}`);
    };
    new Function("require", "module", "exports", "window", "document", "console", compiled.get(file))(
      mockRequire, module, module.exports, window, document, { ...console, error() {} },
    );
    modules.set(file, module.exports);
    return module.exports;
  }
  const render = kind === "explorer" ? load("src/hooks/useFileExplorer.ts").useFileExplorer :
    () => load("src/components/GlobalSearchPanel.tsx").default({ root: folder, onOpenResult() {}, onClose() {} });
  const h = {
    calls, directories, watchers, timers, intervals,
    select: (dir) => { selection = dir; },
    overrideRead: (fn) => { readOverride = fn; },
    failWatching: () => { watchFailure = true; },
    render() { cursor = 0; h.value = render(); effects.splice(0).forEach((fn) => fn()); return h.value; },
    async settle() { await new Promise(setImmediate); h.render(); },
    async flush() { const ready = [...timers.values()]; timers.clear(); ready.forEach((fn) => fn()); await h.settle(); },
    emit(dir, type = { create: { kind: "file" } }) { assert.ok(watchers.has(dir), `No watcher for ${dir}`); watchers.get(dir)({ type, paths: [], attrs: {} }); },
    focus() { listeners.get("focus")?.(); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
  h.render();
  return h;
}

async function open(h) { await h.value.openFolder(); await h.settle(); await h.flush(); }
function elements(node, type) {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap((n) => elements(n, type));
  return [...(node.type === type ? [node] : []), ...elements(node.props?.children, type)];
}
function text(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  return node ? text(node.props?.children) : "";
}

test("dotfiles and dotfolders are visible while excluded directories stay hidden", async () => {
  const h = harness();
  h.directories.set(folder, [entry(".env"), entry(".gitignore"), entry(".config", true), entry(".git", true), entry("node_modules", true), entry("a.txt")]);
  await open(h);
  assert.deepEqual(h.value.root.children.map((n) => n.name), [".config", ".env", ".gitignore", "a.txt"]);
});

test("external create, delete and rename refresh the root with debouncing", async () => {
  const h = harness();
  h.directories.set(folder, [entry("old.txt")]);
  await open(h);
  const before = h.calls.reads.length;
  h.directories.set(folder, [entry("new.txt"), entry(".env")]);
  h.emit(folder); h.emit(folder, { remove: { kind: "file" } }); h.emit(folder, { modify: { kind: "rename", mode: "both" } });
  await h.flush();
  assert.equal(h.calls.reads.length, before + 1);
  assert.deepEqual(h.value.root.children.map((n) => n.name), [".env", "new.txt"]);
  assert.ok(h.calls.watches.every(({ options }) => options.recursive === false));
});

test("expanded subfolders refresh without losing cached descendants", async () => {
  const h = harness();
  const sub = `${folder}\\sub`;
  h.directories.set(folder, [entry("sub", true)]);
  h.directories.set(sub, [entry("a.txt")]);
  await open(h);
  await h.value.toggleDir(h.value.root.children[0]); await h.settle(); await h.flush();
  h.directories.set(sub, [entry("b.txt")]); h.emit(sub); await h.flush();
  h.emit(folder); await h.flush();
  assert.ok(h.value.expanded.has(sub));
  assert.deepEqual(h.value.root.children[0].children.map((n) => n.name), ["b.txt"]);
});

test("collapsed directories are refreshed when reopened", async () => {
  const h = harness();
  const sub = `${folder}\\sub`;
  h.directories.set(folder, [entry("sub", true)]); h.directories.set(sub, [entry("a.txt")]);
  await open(h);
  await h.value.toggleDir(h.value.root.children[0]); await h.settle(); await h.flush();
  await h.value.toggleDir(h.value.root.children[0]); await h.settle();
  assert.equal(h.watchers.has(sub), false);
  h.directories.set(sub, [entry("new.txt")]);
  await h.value.toggleDir(h.value.root.children[0]); await h.settle();
  assert.deepEqual(h.value.root.children[0].children.map((n) => n.name), ["new.txt"]);
});

test("access events do not cause read loops; focus reconciles missed events", async () => {
  const h = harness(); await open(h);
  const before = h.calls.reads.length;
  h.emit(folder, { access: { kind: "open", mode: "read" } }); await h.flush();
  h.emit(folder, { modify: { kind: "data", mode: "content" } }); await h.flush();
  assert.equal(h.calls.reads.length, before);
  h.directories.set(folder, [entry("missed.txt")]); h.focus(); await h.flush();
  assert.equal(h.value.root.children[0].name, "missed.txt");
});

test("switching folders and unmounting release watchers and timers", async () => {
  const h = harness(); await open(h);
  h.emit(folder);
  const other = "D:\\other"; h.directories.set(other, []); h.select(other);
  await open(h);
  assert.equal(h.watchers.has(folder), false);
  assert.equal(h.watchers.has(other), true);
  h.unmount();
  assert.equal(h.watchers.size, 0); assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
});

test("failed watchers fall back to polling", async () => {
  const h = harness(); h.failWatching(); await open(h);
  assert.equal(h.intervals.size, 1);
  h.directories.set(folder, [entry("polled.txt")]);
  [...h.intervals.values()].forEach((fn) => fn()); await h.flush();
  assert.equal(h.value.root.children[0].name, "polled.txt");
  h.unmount(); assert.equal(h.intervals.size, 0);
});

test("older directory reads cannot overwrite a newer refresh", async () => {
  const h = harness(); await open(h);
  const reads = [];
  h.overrideRead(() => new Promise((resolve) => reads.push(resolve)));
  h.emit(folder); await h.flush();
  h.emit(folder); await h.flush();
  assert.equal(reads.length, 2);
  reads[1]([entry("new.txt")]); await h.settle();
  reads[0]([entry("stale.txt")]); await h.settle();
  assert.equal(h.value.root.children[0].name, "new.txt");
});

test("external subfolder deletion removes its watcher", async () => {
  const h = harness();
  const sub = `${folder}\\sub`;
  h.directories.set(folder, [entry("sub", true)]); h.directories.set(sub, []);
  await open(h);
  await h.value.toggleDir(h.value.root.children[0]); await h.settle(); await h.flush();
  assert.ok(h.watchers.has(sub));
  h.directories.set(folder, []); h.emit(folder, { remove: { kind: "folder" } }); await h.flush();
  assert.deepEqual(h.value.root.children, []);
  assert.equal(h.watchers.has(sub), false);
});

test("reopening the sidebar reconciles changes made while it was hidden", async () => {
  const h = harness(); await open(h);
  h.value.toggle(); await h.settle();
  assert.equal(h.watchers.size, 0);
  h.directories.set(folder, [entry("hidden-time.txt")]);
  h.value.toggle(); await h.settle(); await h.flush();
  assert.equal(h.value.root.children[0].name, "hidden-time.txt");
});

for (const [name, filesTruncated, lineTruncated] of [["file limit", true, false], ["line limit", false, true], ["complete results", false, false]]) {
  test(`search panel reports ${name} correctly`, async () => {
    const h = harness("search", { files: [{ path: `${folder}\\a.txt`, name: "a.txt", matches: [{ line: 1, text: "hello" }], truncated: lineTruncated }], filesTruncated });
    elements(h.value, "input")[0].props.onChange({ target: { value: "hello" } });
    h.render(); await h.flush();
    const rendered = text(h.value);
    assert.match(rendered, /hello/);
    if (filesTruncated) assert.match(rendered, /更多命中文件/);
    if (lineTruncated) assert.match(rendered, /命中行/);
    if (!filesTruncated && !lineTruncated) assert.doesNotMatch(rendered, /不完整|已省略/);
  });
}
