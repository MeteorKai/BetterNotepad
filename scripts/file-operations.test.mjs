import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const source = (file) => ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const compiled = new Map(["src/App.tsx", "src/hooks/useTabs.ts", "src/i18n/index.ts"].map((file) => [file, source(file)]));

const folder = "D:\\work\\old";
const node = (filePath, isDir = false) => ({ path: filePath, name: filePath.split(/[\\/]/).pop(), isDir });
const tab = (filePath, patch = {}) => ({
  filePath, fileName: filePath.split(/[\\/]/).pop(), content: "original", modified: false,
  encoding: "utf-8", eol: "lf", diskVersion: "disk", ...patch,
});

// Exercise the real hook and App handlers without mounting a DOM. Hook state
// survives renders; effects, native dialogs and filesystem I/O are mocked.
function harness(initialTabs, operations = {}) {
  const slots = [];
  const calls = { deletes: [], renames: [], writes: [], alerts: [], prompts: [], stops: [] };
  let cursor = 0;
  let tabs;
  let prepareUpdate;
  const storage = new Map([["betternotepad.session", JSON.stringify({ version: 1, activeIndex: 0, tabs: initialTabs })]]);
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (update) => { slots[index] = typeof update === "function" ? update(slots[index]) : update; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: (fn) => fn,
    useEffect() {},
  };
  const explorer = {
    isOpen: true, root: node("D:\\work", true), expanded: new Set(), folderPath: "D:\\work",
    async deleteNode(target) {
      calls.deletes.push(target.path);
      return operations.deleteNode ? operations.deleteNode(target) : true;
    },
    async renameNode(target, name) {
      calls.renames.push([target.path, name]);
      return operations.renameNode ? operations.renameNode(target, name) : `D:\\work\\${name}`;
    },
  };
  const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const invoke = async (command, args) => {
    if (command === "write_file") { calls.writes.push(args); return operations.writeFile ? operations.writeFile(args) : "saved-disk"; }
    throw new Error(`Unexpected native command: ${command}`);
  };
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    cache.set(file, module.exports);
    const mockRequire = (id) => {
      if (id === "react") return react;
      if (id === "react/jsx-runtime") return require(id);
      if (id === "@tauri-apps/api/core") return { invoke };
      if (id === "@tauri-apps/plugin-dialog") return { ask: async (message) => {
        calls.prompts.push(message);
        if (operations.onAsk) operations.onAsk(result);
        return operations.approve !== false;
      } };
      if (id.startsWith("@tauri-apps/")) return {};
      if (id === "../i18n" || id === "./i18n") return load("src/i18n/index.ts");
      if (id === "./hooks/useTabs") {
        const actual = load("src/hooks/useTabs.ts");
        return { ...actual, useTabs: (...args) => { tabs = actual.useTabs(...args); return tabs; } };
      }
      if (id === "./hooks/useFileExplorer") return { useFileExplorer: () => explorer };
      if (id === "./hooks/useEditorSettings") return { useEditorSettings: () => ({ settings: { locale: "zh", defaultEol: "lf", runCwdMode: "folder", runCwdCustom: "" } }) };
      if (id === "./hooks/useEditorState") return { useEditorState: () => ({ cursorLine: 1, cursorCol: 1, totalLines: 1 }) };
      if (id === "./hooks/useTheme") return { useTheme: () => ({ theme: "light" }) };
      if (id === "./hooks/useMascot") return { useMascot: () => ({ visible: false }) };
      if (id === "./hooks/useRunner") return { useRunner: () => ({ running: operations.running ?? false, config: [],
        stop: async () => { calls.stops.push("run"); }, closeShell: async () => { calls.stops.push("shell"); },
      }) };
      if (id === "./hooks/useUpdater") return { useUpdater: (prepare) => {
        prepareUpdate = prepare; return { busy: false, busyRef: { current: false } };
      } };
      if (id.startsWith("./components/")) return { __esModule: true, default: id.slice("./components/".length) };
      throw new Error(`Unexpected import: ${id}`);
    };
    new Function("require", "module", "exports", "window", "localStorage", "alert", compiled.get(file))(
      mockRequire, module, module.exports, { __TAURI_INTERNALS__: {}, setTimeout: () => 1,
        requestAnimationFrame: (callback) => { result.render(); callback(); },
      }, localStorage,
      (message) => calls.alerts.push(message),
    );
    return module.exports;
  };
  const App = load("src/App.tsx").default;
  function findExplorer(element) {
    if (!element) return null;
    if (Array.isArray(element)) return element.map(findExplorer).find(Boolean);
    return element.type === "FileExplorer" ? element.props : findExplorer(element.props?.children);
  }
  const result = {
    calls,
    get tabs() { return tabs; },
    prepareUpdate: () => prepareUpdate(),
    render() { cursor = 0; result.explorer = findExplorer(App()); },
  };
  result.render();
  return result;
}

test("deleting an unsaved file is blocked and activates its tab", async () => {
  const file = `${folder}\\a.txt`;
  const h = harness([tab("D:\\work\\other.txt"), tab(file, { modified: true, content: "draft" })]);
  await h.explorer.onDelete(node(file));
  h.render();
  assert.equal(h.calls.deletes.length, 0);
  assert.equal(h.tabs.activeTab.filePath, file);
  assert.equal(h.tabs.activeTab.content, "draft");
  assert.equal(h.calls.alerts.length, 1);
  assert.match(h.calls.alerts[0], /a\.txt/);
});

test("deleting a folder checks unsaved nested tabs but not similarly named siblings", async () => {
  const h = harness([tab(`${folder}\\nested\\a.txt`, { modified: true })]);
  await h.explorer.onDelete(node(folder, true));
  assert.equal(h.calls.deletes.length, 0);
  const sibling = harness([tab(`${folder}-copy\\a.txt`, { modified: true })]);
  await sibling.explorer.onDelete(node(folder, true));
  sibling.render();
  assert.equal(sibling.calls.deletes.length, 1);
  assert.equal(sibling.tabs.tabs[0].modified, true);
});

test("deleting a saved file closes its tab and leaves an empty tab", async () => {
  const file = `${folder}\\a.txt`;
  const h = harness([tab(file)]);
  await h.explorer.onDelete(node(file));
  h.render();
  assert.equal(h.calls.deletes.length, 1);
  assert.equal(h.tabs.tabs.length, 1);
  assert.equal(h.tabs.activeTab.filePath, null);
  assert.equal(h.calls.alerts.length, 0);
});

test("deleting a saved folder closes its descendant tabs only", async () => {
  const sibling = `${folder}-copy\\a.txt`;
  const h = harness([tab(`${folder}\\a.txt`), tab(`${folder}\\nested\\b.txt`), tab(sibling)]);
  await h.explorer.onDelete(node(folder, true));
  h.render();
  assert.deepEqual(h.tabs.tabs.map((t) => t.filePath), [sibling]);
});

test("failed deletion leaves the tabs unchanged", async () => {
  const h = harness([tab(`${folder}\\a.txt`)], { deleteNode: () => false });
  const before = h.tabs.tabs;
  await h.explorer.onDelete(node(folder, true));
  h.render();
  assert.equal(h.tabs.tabs, before);
});

test("edits made while deletion is in flight remain recoverable", async () => {
  let finishDelete;
  const h = harness([tab(`${folder}\\a.txt`)], { deleteNode: () => new Promise((resolve) => { finishDelete = resolve; }) });
  const deletion = h.explorer.onDelete(node(folder, true));
  h.tabs.setActiveContent("late edit");
  h.render();
  finishDelete(true);
  await deletion;
  h.render();
  assert.equal(h.tabs.activeTab.content, "late edit");
  assert.equal(h.tabs.activeTab.modified, true);
  assert.equal(h.tabs.activeTab.externalChange, "missing");
});

test("folder rename updates all descendant paths and preserves tab state", async () => {
  const h = harness([
    tab(`${folder}\\a.txt`, { modified: true, content: "draft", externalChange: "changed", reloadRevision: 3 }),
    tab(`${folder}\\nested\\b.txt`), tab(`${folder}-copy\\c.txt`),
  ]);
  const before = h.tabs.tabs;
  const activeId = h.tabs.activeTabId;
  await h.explorer.onRename(node(folder, true), "new");
  h.render();
  assert.deepEqual(h.tabs.tabs.map((t) => t.filePath), ["D:\\work\\new\\a.txt", "D:\\work\\new\\nested\\b.txt", `${folder}-copy\\c.txt`]);
  assert.equal(h.tabs.activeTabId, activeId);
  assert.equal(h.tabs.tabs[2], before[2]);
  assert.deepEqual(h.tabs.tabs[0], { ...before[0], filePath: "D:\\work\\new\\a.txt" });
  await h.tabs.saveTabData(h.tabs.tabs[1]);
  assert.equal(h.calls.writes[0].path, "D:\\work\\new\\nested\\b.txt");
});

test("Windows path matching accepts case and separator differences", async () => {
  const h = harness([tab("d:/WORK/OLD/nested/a.txt", { modified: true })]);
  await h.explorer.onDelete(node(`${folder}\\`, true));
  assert.equal(h.calls.deletes.length, 0);
  await h.explorer.onRename(node(`${folder}\\`, true), "new");
  h.render();
  assert.equal(h.tabs.activeTab.filePath, "D:\\work\\new/nested/a.txt");
});

test("single-file rename still updates its name and path", async () => {
  const h = harness([tab(`${folder}\\a.txt`, { modified: true })], { renameNode: () => `${folder}\\renamed.txt` });
  const id = h.tabs.activeTabId;
  await h.explorer.onRename(node(`${folder}\\a.txt`), "renamed.txt");
  h.render();
  assert.equal(h.tabs.activeTab.filePath, `${folder}\\renamed.txt`);
  assert.equal(h.tabs.activeTab.fileName, "renamed.txt");
  assert.equal(h.tabs.activeTabId, id);
  assert.equal(h.tabs.activeTab.modified, true);
});

test("failed rename leaves descendant paths unchanged", async () => {
  const h = harness([tab(`${folder}\\a.txt`)], { renameNode: () => null });
  const before = h.tabs.tabs;
  await h.explorer.onRename(node(folder, true), "new");
  h.render();
  assert.equal(h.tabs.tabs, before);
});

test("update save prompt cancellation preserves all drafts and stops no terminals", async () => {
  const h = harness([tab(`${folder}\\a.txt`, { modified: true, content: "draft" })], { approve: false });
  assert.equal(await h.prepareUpdate(), false);
  assert.equal(h.calls.writes.length, 0);
  assert.deepEqual(h.calls.stops, []);
  assert.equal(h.tabs.activeTab.content, "draft");
});

test("update saves all dirty tabs before persisting and stopping terminals", async () => {
  const h = harness([tab(`${folder}\\a.txt`, { modified: true }), tab(`${folder}\\b.txt`, { modified: true })]);
  assert.equal(await h.prepareUpdate(), true);
  assert.equal(h.calls.writes.length, 2);
  assert.equal(h.tabs.unsavedTabs.length, 0);
  assert.deepEqual(h.calls.stops, ["run", "shell"]);
});

test("failed update save and declined terminal shutdown both stop installation", async () => {
  const failed = harness([tab(`${folder}\\a.txt`, { modified: true })], { writeFile: () => { throw new Error("disk full"); } });
  assert.equal(await failed.prepareUpdate(), false);
  assert.deepEqual(failed.calls.stops, []);
  const running = harness([tab(`${folder}\\a.txt`)], { running: true, approve: false });
  assert.equal(await running.prepareUpdate(), false);
  assert.deepEqual(running.calls.stops, []);
});

test("new unsaved content appearing during restart confirmation blocks installation", async () => {
  const h = harness([tab(`${folder}\\a.txt`)], { running: true, onAsk: (current) => {
    current.tabs.setActiveContent("late change"); current.render();
  } });
  assert.equal(await h.prepareUpdate(), false);
  assert.equal(h.tabs.activeTab.content, "late change");
  assert.equal(h.tabs.activeTab.modified, true);
});
