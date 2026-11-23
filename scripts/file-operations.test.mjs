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
  const calls = { deletes: [], renames: [], writes: [], alerts: [], prompts: [], stops: [], backups: [] };
  let cursor = 0;
  let tabs;
  let prepareUpdate;
  const storage = new Map([["betternotepad.session", JSON.stringify({ version: 1, activeIndex: 0, tabs: initialTabs })]]);
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (update) => {
        const previous = slots[index];
        const next = typeof update === "function" ? update(previous) : update;
        if (operations.replayStateUpdater && typeof update === "function") update(previous);
        slots[index] = next;
      }];
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
      return operations.deleteNode ? operations.deleteNode(target) : null;
    },
    async renameNode(target, name) {
      calls.renames.push([target.path, name]);
      return operations.renameNode ? operations.renameNode(target, name) : `D:\\work\\${name}`;
    },
  };
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      if (operations.sessionError && key === "betternotepad.session") throw new Error("QuotaExceededError");
      storage.set(key, value);
    },
  };
  const invoke = async (command, args) => {
    if (command === "write_file") { calls.writes.push(args); return operations.writeFile ? operations.writeFile(args) : "saved-disk"; }
    if (command === "read_file") return operations.readFile ? operations.readFile(args.path) : { content: "opened", encoding: "utf-8", fingerprint: "disk" };
    if (command === "save_session_backup") {
      calls.backups.push(args.contents);
      return operations.writeBackup?.(args.contents);
    }
    if (command === "file_fingerprint") return operations.fingerprint ?? null;
    if (command === "get_file_name") return String(args.path).split(/[\\/]/).pop();
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
      if (id === "@tauri-apps/plugin-dialog") return { save: async () => operations.savePath, ask: async (message) => {
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
  function findTabBar(element) {
    if (!element) return null;
    if (Array.isArray(element)) return element.map(findTabBar).find(Boolean);
    return element.type === "TabBar" ? element.props : findTabBar(element.props?.children);
  }
  const result = {
    calls, storage,
    get tabs() { return tabs; },
    prepareUpdate: () => prepareUpdate(),
    render() {
      cursor = 0;
      const tree = App({ desktopSession: operations.desktopSession });
      result.explorer = findExplorer(tree);
      result.tabBar = findTabBar(tree);
    },
  };
  result.render();
  return result;
}

test("Save As refuses to replace a destination already open in another tab", async () => {
  const target = "D:\\work\\destination.txt";
  const h = harness([tab("D:\\work\\a.txt", { modified: true }), tab(target)], {
    savePath: "d:/WORK/destination.txt",
  });
  await h.tabs.saveActiveAs();
  h.render();
  assert.equal(h.calls.writes.length, 0);
  assert.ok(h.tabs.fileNotice);
});

test("Save As guards both an existing and a previously missing destination", async () => {
  for (const fingerprint of ["existing-version", null]) {
    const h = harness([tab("D:\\work\\a.txt", { modified: true })], {
      savePath: "D:\\work\\destination.txt", fingerprint,
    });
    await h.tabs.saveActiveAs();
    assert.equal(h.calls.writes.length, 1);
    assert.equal(h.calls.writes[0].expectedFingerprint, fingerprint ?? undefined);
    assert.equal(h.calls.writes[0].expectMissing, fingerprint === null);
  }
});

test("Save All reports an edit to a previously clean tab during a write", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const h = harness([tab("D:\\work\\a.txt", { modified: true }), tab("D:\\work\\b.txt")], {
    writeFile: () => pending,
  });
  const saving = h.tabs.saveAll();
  h.tabs.setTabEncoding(h.tabs.tabs[1].id, "gbk");
  h.render();
  finish("saved");
  assert.equal(await saving, false);
  h.render();
  assert.equal(h.tabs.tabs[1].modified, true);
  assert.equal(h.tabs.tabs[1].encoding, "gbk");
});

test("a failed session write keeps the earlier backup and exposes the failure", async () => {
  const options = { sessionError: true };
  const h = harness([tab("D:\\work\\a.txt", { modified: true })], options);
  const original = h.storage.get("betternotepad.session");
  assert.equal(await h.tabs.persistSessionNow(), false);
  h.render();
  assert.equal(h.tabs.sessionError, "write");
  assert.equal(h.storage.get("betternotepad.session"), original);
  options.sessionError = false;
  assert.equal(await h.tabs.persistSessionNow(), true);
  h.render();
  assert.equal(h.tabs.sessionError, false);
});

test("a desktop backup over the size limit preserves the draft and reports the limit", async () => {
  const h = harness([{ filePath: null, fileName: "draft.txt", modified: true, content: "current draft" }], {
    desktopSession: { contents: null }, writeBackup: async () => { throw new Error("SESSION_TOO_LARGE"); },
  });
  assert.equal(await h.tabs.persistSessionNow(), false);
  h.render();
  assert.equal(h.tabs.sessionError, "limit");
  assert.equal(h.tabs.activeTab.content, "current draft");
});

test("desktop migration keeps legacy drafts and bypasses the localStorage quota", async () => {
  const draft = "你好".repeat(1_000_000);
  const h = harness([{ filePath: null, fileName: "draft.txt", modified: true, content: draft }], {
    desktopSession: { contents: null }, sessionError: true,
  });
  assert.equal(h.tabs.activeTab.content, draft);
  assert.equal(await h.tabs.persistSessionNow(), true);
  assert.equal(JSON.parse(h.calls.backups[0]).tabs[0].content, draft);
  assert.equal(JSON.parse(h.storage.get("betternotepad.session")).tabs[0].content, draft);
});

test("the desktop backup wins over legacy data, even when it has no drafts", () => {
  const h = harness([{ filePath: null, fileName: "old", modified: true, content: "legacy" }], {
    desktopSession: { contents: JSON.stringify({ version: 1, activeIndex: 0, tabs: [] }) },
  });
  assert.equal(h.tabs.activeTab.content, "");
});

test("a restored placeholder cannot be edited or saved before its contents load", async () => {
  const options = { readFile: async () => { throw new Error("FILE_TOO_LARGE"); } };
  const h = harness([tab("D:\\work\\large.txt", { content: "" })], options);
  assert.equal(h.tabs.activeTab.needsDiskLoad, true);
  h.tabs.setActiveContent("should not replace disk contents");
  h.tabs.setTabEncoding(h.tabs.activeTabId, "gbk");
  await h.tabs.saveActive();
  await h.tabs.saveActiveAs();
  await h.tabs.overwriteExternalChange(h.tabs.activeTabId);
  assert.equal(h.calls.writes.length, 0);
  await h.tabs.reloadTabFromDisk(h.tabs.activeTabId);
  h.render();
  assert.equal(h.tabs.activeTab.modified, false);
  assert.match(h.tabs.activeTab.diskLoadError, /64 MiB/);
  options.readFile = async () => ({ content: "actual disk contents", encoding: "utf-8", fingerprint: "new" });
  await h.tabs.reloadTabFromDisk(h.tabs.activeTabId);
  h.render();
  assert.equal(h.tabs.activeTab.needsDiskLoad, false);
  assert.equal(h.tabs.activeTab.diskLoadError, undefined);
  assert.equal(h.tabs.activeTab.content, "actual disk contents");
});

test("an unloaded missing file stays a placeholder across repeated recovery", async () => {
  const initial = JSON.stringify({ version: 1, activeIndex: 0,
    tabs: [tab("D:\\work\\missing.txt", { content: "", externalChange: "missing", needsDiskLoad: true })] });
  const first = harness([], { desktopSession: { contents: initial } });
  assert.equal(first.tabs.activeTab.needsDiskLoad, true);
  assert.equal(await first.tabs.persistSessionNow(), true);
  const restored = harness([], { desktopSession: { contents: first.calls.backups[0] } });
  assert.equal(restored.tabs.activeTab.needsDiskLoad, true);
  assert.equal(restored.tabs.activeTab.externalChange, "missing");
});

test("unreadable desktop backups are preserved", async () => {
  const h = harness([], { desktopSession: { contents: "{not JSON" } });
  assert.equal(h.tabs.sessionLoadFailed, true);
  assert.equal(await h.tabs.persistSessionNow(), false);
  assert.equal(h.calls.backups.length, 0);
});

test("discard waits for an in-flight autosave and blocks subsequent autosaves", async () => {
  let finishFirst;
  const first = new Promise((resolve) => { finishFirst = resolve; });
  let writes = 0;
  const h = harness([{ filePath: null, fileName: "draft", modified: true, content: "draft" }], {
    desktopSession: { contents: null }, writeBackup: () => ++writes === 1 ? first : undefined,
  });
  const autosave = h.tabs.persistSessionNow();
  await Promise.resolve();
  const discard = h.tabs.discardUnsavedFromSession();
  assert.equal(await h.tabs.persistSessionNow(), false);
  assert.equal(h.calls.backups.length, 1);
  finishFirst();
  assert.equal(await autosave, true);
  assert.equal(await discard, true);
  assert.deepEqual(JSON.parse(h.calls.backups[1]).tabs, []);
});

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
  const h = harness([tab(`${folder}\\a.txt`)], { deleteNode: () => "recycle bin unavailable" });
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
  finishDelete(null);
  await deletion;
  h.render();
  assert.equal(h.tabs.activeTab.content, "late edit");
  assert.equal(h.tabs.activeTab.modified, true);
  assert.equal(h.tabs.activeTab.externalChange, "missing");
});

test("failed deletion alerts with the reason and keeps tabs open", async () => {
  const h = harness([tab(`${folder}\\a.txt`)], { deleteNode: () => "Failed to move to the Recycle Bin: access denied" });
  await h.explorer.onDelete(node(`${folder}\\a.txt`));
  h.render();
  assert.equal(h.calls.alerts.length, 1);
  assert.match(h.calls.alerts[0], /删除失败/);
  assert.match(h.calls.alerts[0], /Recycle Bin/);
  assert.equal(h.tabs.tabs[0].filePath, `${folder}\\a.txt`);
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

test("a failed recovery backup blocks preparation without stopping the terminal", async () => {
  const h = harness([tab("D:\\work\\a.txt")], { running: true, sessionError: true });
  assert.equal(await h.prepareUpdate(), false);
  assert.deepEqual(h.calls.stops, []);
  assert.match(h.calls.alerts[0], /已取消安装更新/);
});

test("update verifies that an unchanged desktop snapshot can still be committed", async () => {
  const options = {
    desktopSession: { contents: null },
    writeBackup: async () => {},
  };
  const h = harness([], options);
  assert.equal(await h.tabs.persistSessionNow(), true);
  options.writeBackup = async () => { throw new Error("destination is no longer writable"); };
  assert.equal(await h.tabs.persistSessionNow(false), true);
  assert.equal(h.calls.backups.length, 1);
  assert.equal(await h.prepareUpdate(), false);
  assert.equal(h.calls.backups.length, 2);
  assert.deepEqual(h.calls.stops, []);
  assert.equal(await h.tabs.persistSessionNow(false), false);
  h.render();
  assert.equal(h.tabs.sessionError, "write");
  options.writeBackup = async () => {};
  assert.equal(await h.tabs.persistSessionNow(false), true);
  h.render();
  assert.equal(h.tabs.sessionError, false);
  assert.equal(h.calls.backups.length, 4);
});

test("failed update save and declined terminal shutdown both stop installation", async () => {
  const failed = harness([tab(`${folder}\\a.txt`, { modified: true })], { writeFile: () => { throw new Error("disk full"); } });
  assert.equal(await failed.prepareUpdate(), false);
  assert.deepEqual(failed.calls.stops, []);
  const running = harness([tab(`${folder}\\a.txt`)], { running: true, approve: false });
  assert.equal(await running.prepareUpdate(), false);
  assert.deepEqual(running.calls.stops, []);
});

test("reopens recently closed tabs in LIFO order at their original position", () => {
  const h = harness([tab("D:\\work\\a.txt"), tab("D:\\work\\b.txt"), tab("D:\\work\\c.txt")]);
  const b = h.tabs.tabs[1].id;
  const c = h.tabs.tabs[2].id;
  h.tabs.closeTab(b);
  h.render();
  h.tabs.closeTab(c);
  h.render();
  assert.equal(h.tabs.canReopenClosedTab, true);
  h.tabs.reopenClosedTab();
  h.render();
  assert.deepEqual(h.tabs.tabs.map((t) => t.filePath), ["D:\\work\\a.txt", "D:\\work\\c.txt"]);
  h.tabs.reopenClosedTab();
  h.render();
  assert.deepEqual(h.tabs.tabs.map((t) => t.filePath), ["D:\\work\\a.txt", "D:\\work\\b.txt", "D:\\work\\c.txt"]);
});

test("reopening replaces the sole default placeholder and keeps a closed draft", () => {
  const h = harness([tab("D:\\work\\draft.txt", { content: "draft", modified: true, encoding: "gbk", eol: "crlf", externalChange: "missing" })]);
  const id = h.tabs.activeTabId;
  h.tabs.requestClose(id);
  h.render();
  h.tabs.confirmPendingClose(false);
  h.render();
  assert.equal(h.tabs.tabs.length, 1);
  assert.equal(h.tabs.tabs[0].filePath, null);
  h.tabs.reopenClosedTab();
  h.render();
  assert.equal(h.tabs.tabs.length, 1);
  assert.equal(h.tabs.activeTab.filePath, "D:\\work\\draft.txt");
  assert.notEqual(h.tabs.activeTab.id, id);
  assert.equal(h.tabs.activeTab.content, "draft");
  assert.equal(h.tabs.activeTab.modified, true);
  assert.equal(h.tabs.activeTab.encoding, "gbk");
  assert.equal(h.tabs.activeTab.eol, "crlf");
  assert.equal(h.tabs.activeTab.externalChange, "missing");
});

test("cancelled or failed close confirmation does not add closed history", async () => {
  const cancelled = harness([tab("D:\\work\\draft.txt", { content: "draft", modified: true })]);
  cancelled.tabs.requestClose(cancelled.tabs.activeTabId);
  cancelled.render();
  cancelled.tabs.cancelPendingClose();
  cancelled.render();
  assert.equal(cancelled.tabs.canReopenClosedTab, false);

  const failed = harness([tab("D:\\work\\draft.txt", { content: "draft", modified: true })], { writeFile: () => { throw new Error("disk full"); } });
  failed.tabs.requestClose(failed.tabs.activeTabId);
  failed.render();
  await failed.tabs.confirmPendingClose(true);
  failed.render();
  assert.equal(failed.tabs.tabs.length, 1);
  assert.equal(failed.tabs.canReopenClosedTab, false);
});

test("duplicate close updater calls add history only once", () => {
  const h = harness([tab("D:\\work\\a.txt")], { replayStateUpdater: true });
  h.tabs.closeTab(h.tabs.activeTabId);
  h.render();
  h.tabs.reopenClosedTab();
  h.render();
  assert.equal(h.tabs.tabs.filter((t) => t.filePath === "D:\\work\\a.txt").length, 1);
  assert.equal(h.tabs.canReopenClosedTab, false);
});

test("automatic placeholder cleanup does not add closed history", () => {
  const h = harness([tab("D:\\work\\a.txt")]);
  h.tabs.closeTab(h.tabs.activeTabId, false);
  h.render();
  assert.equal(h.tabs.tabs.length, 1);
  assert.equal(h.tabs.tabs[0].filePath, null);
  assert.equal(h.tabs.canReopenClosedTab, false);
});

test("closed history is capped and physical deletion does not remember tabs", () => {
  const many = harness(Array.from({ length: 22 }, (_, i) => tab(`D:\\work\\${i}.txt`)));
  for (let i = 0; i < 22; i += 1) {
    many.tabs.closeTab(many.tabs.tabs[0].id);
    many.render();
  }
  for (let i = 0; i < 20; i += 1) {
    many.tabs.reopenClosedTab();
    many.render();
  }
  assert.equal(many.tabs.canReopenClosedTab, false);
  const deleted = harness([tab("D:\\work\\gone.txt")]);
  deleted.tabs.closeOpenFile("D:\\work\\gone.txt");
  deleted.render();
  assert.equal(deleted.tabs.canReopenClosedTab, false);
});

test("opening a Windows path alias reuses the existing draft tab", async () => {
  const h = harness([tab("D:\\work\\a.txt", { content: "draft", modified: true })]);
  await h.tabs.openPaths(["d:/WORK/a.txt"]);
  h.render();
  assert.equal(h.tabs.tabs.length, 1);
  assert.equal(h.tabs.activeTab.filePath, "D:\\work\\a.txt");
  assert.equal(h.tabs.activeTab.content, "draft");
  assert.equal(h.tabs.activeTab.modified, true);
});

test("reopening a closed path alias does not duplicate an opened tab", async () => {
  const h = harness([tab("D:\\work\\a.txt")]);
  h.tabs.closeTab(h.tabs.activeTabId);
  h.render();
  await h.tabs.openPaths(["d:/WORK/a.txt"]);
  h.render();
  assert.equal(h.tabs.tabs.filter((tab) => tab.filePath && tab.filePath.toLowerCase().replace(/\\/g, "/") === "d:/work/a.txt").length, 1);
  h.tabs.reopenClosedTab();
  h.render();
  assert.equal(h.tabs.tabs.filter((tab) => tab.filePath && tab.filePath.toLowerCase().replace(/\\/g, "/") === "d:/work/a.txt").length, 1);
  assert.equal(h.tabs.activeTab.filePath, "d:/WORK/a.txt");
  assert.equal(h.tabs.canReopenClosedTab, false);
});

test("reopening an already open path only activates it without replacing edits", async () => {
  const h = harness([tab("D:\\work\\a.txt"), tab("D:\\work\\b.txt")]);
  h.tabs.closeTab(h.tabs.tabs[0].id);
  h.render();
  await h.tabs.openPaths(["D:\\work\\a.txt"]);
  h.render();
  const current = h.tabs.tabs.find((t) => t.filePath === "D:\\work\\a.txt");
  h.tabs.activateTab(current.id);
  h.tabs.setActiveContent("current edits");
  h.render();
  h.tabs.reopenClosedTab();
  h.render();
  assert.equal(h.tabs.activeTabId, current.id);
  assert.equal(h.tabs.activeTab.content, "current edits");
});

test("App passes closed-tab restore state to TabBar", () => {
  const h = harness([tab("D:\\work\\a.txt")]);
  assert.equal(h.tabBar.canReopenClosedTab, false);
  h.tabs.closeTab(h.tabs.activeTabId);
  h.render();
  assert.equal(h.tabBar.canReopenClosedTab, true);
  assert.equal(typeof h.tabBar.onReopenClosedTab, "function");
});

test("new unsaved content appearing during restart confirmation blocks installation", async () => {
  const h = harness([tab(`${folder}\\a.txt`)], { running: true, onAsk: (current) => {
    current.tabs.setActiveContent("late change"); current.render();
  } });
  assert.equal(await h.prepareUpdate(), false);
  assert.equal(h.tabs.activeTab.content, "late change");
  assert.equal(h.tabs.activeTab.modified, true);
});
