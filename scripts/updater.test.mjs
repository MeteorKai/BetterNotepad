import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(fs.readFileSync(new URL("../src/hooks/useUpdater.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText;
const i18nModule = { exports: {} };
new Function("module", "exports", ts.transpileModule(fs.readFileSync(new URL("../src/i18n/index.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText)(i18nModule, i18nModule.exports);

function harness(options = {}) {
  const slots = [];
  const calls = [];
  let cursor = 0;
  let prepare = options.prepare ?? (async () => { calls.push("prepare"); return true; });
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], (update) => { slots[i] = typeof update === "function" ? update(slots[i]) : update; }];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useCallback: (fn) => fn,
  };
  const update = {
    version: "0.4.7",
    async download(callback, downloadOptions) {
      calls.push("download");
      assert.equal(downloadOptions.timeout, 120000);
      if (options.download) return options.download(callback);
      callback({ event: "Started", data: { contentLength: 100 } });
      callback({ event: "Progress", data: { chunkLength: 60 } });
      callback({ event: "Progress", data: { chunkLength: 40 } });
      callback({ event: "Finished" });
    },
    async install() { calls.push("install"); if (options.installError) throw options.installError; },
    async close() { calls.push("close"); },
  };
  const mockRequire = (id) => {
    if (id === "react") return react;
    if (id === "@tauri-apps/api/core") return { invoke: async (command) => {
      if (command === "update_endpoint_status") {
        calls.push("diagnose");
        if (options.diagnosticError) throw options.diagnosticError;
        return options.httpStatus ?? 404;
      }
      assert.equal(command, "update_installation_supported"); calls.push("installed"); return options.installed !== false;
    } };
    if (id === "@tauri-apps/plugin-updater") return { check: async (checkOptions) => {
      calls.push("check"); assert.equal(checkOptions.timeout, 15000);
      if (options.checkError) throw options.checkError;
      return options.latest ? null : update;
    } };
    if (id === "../i18n") return i18nModule.exports;
    return require(id);
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", "window", compiled)(mockRequire, module, module.exports,
    options.browser ? {} : { __TAURI_INTERNALS__: {} });
  const h = { calls, render() { cursor = 0; h.updater = module.exports.useUpdater(prepare); }, setPrepare(fn) { prepare = fn; h.render(); } };
  h.render();
  return h;
}

test("new release is downloaded before the save gate and installed once", async () => {
  const h = harness();
  await h.updater.checkAndInstall();
  h.render();
  assert.deepEqual(h.calls, ["installed", "check", "download", "installed", "prepare", "install", "close"]);
  assert.equal(h.updater.state.version, "0.4.7");
  assert.equal(h.updater.percent, 100);
});

test("latest version does not download, prompt or install", async () => {
  const h = harness({ latest: true });
  await h.updater.checkAndInstall(); h.render();
  assert.deepEqual(h.calls, ["installed", "check"]);
  assert.equal(h.updater.state.phase, "latest");
  assert.equal(h.updater.busy, false);
});

test("browser and loose EXEs do not reach the updater", async () => {
  for (const options of [{ browser: true }, { installed: false }]) {
    const h = harness(options);
    await h.updater.checkAndInstall(); h.render();
    assert.equal(h.updater.state.phase, "error");
    assert.equal(h.calls.includes("check"), false);
    assert.equal(h.updater.busy, false);
  }
});

test("network error is reported and the same button can retry", async () => {
  const options = { checkError: new Error("network timeout") };
  const h = harness(options);
  await h.updater.checkAndInstall(); h.render();
  assert.match(h.updater.message, /超时/);
  assert.match(h.updater.state.error, /network timeout/);
  assert.equal(h.updater.busy, false);
  options.checkError = null;
  await h.updater.checkAndInstall();
  assert.equal(h.calls.filter((call) => call === "install").length, 1);
});

test("signature/download failure never reaches save or install", async () => {
  const h = harness({ download: async () => { throw new Error("invalid signature"); } });
  await h.updater.checkAndInstall(); h.render();
  assert.deepEqual(h.calls, ["installed", "check", "download", "close"]);
  assert.match(h.updater.message, /签名/);
  assert.match(h.updater.state.error, /invalid signature/);
  assert.equal(h.updater.busy, false);
});

test("cancelled saving releases the package without installing", async () => {
  const h = harness({ prepare: async () => false });
  await h.updater.checkAndInstall(); h.render();
  assert.equal(h.updater.state.phase, "cancelled");
  assert.equal(h.calls.includes("install"), false);
  assert.equal(h.calls.at(-1), "close");
});

test("installation failure is recoverable and releases the update resource", async () => {
  const h = harness({ installError: new Error("installer launch failed") });
  await h.updater.checkAndInstall(); h.render();
  assert.equal(h.updater.state.phase, "error");
  assert.match(h.updater.message, /安装器/);
  assert.match(h.updater.state.error, /installer launch failed/);
  assert.equal(h.updater.busy, false);
  assert.equal(h.calls.at(-1), "close");
});

test("repeated clicks are coalesced and the latest save callback is used", async () => {
  let finish;
  const h = harness({ download: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = h.updater.checkAndInstall();
  await new Promise(setImmediate);
  h.render();
  assert.equal(h.updater.busy, true);
  await h.updater.checkAndInstall();
  h.setPrepare(async () => false);
  finish(); await pending; h.render();
  assert.equal(h.calls.filter((call) => call === "check").length, 1);
  assert.equal(h.calls.includes("install"), false);
});

test("missing content length gives indeterminate progress, percentages are clamped", async () => {
  let emit, finish;
  const h = harness({ download: (callback) => new Promise((resolve) => { emit = callback; finish = resolve; }) });
  const pending = h.updater.checkAndInstall();
  await new Promise(setImmediate);
  emit({ event: "Started", data: {} });
  emit({ event: "Progress", data: { chunkLength: 1048576 } }); h.render();
  assert.equal(h.updater.percent, null);
  assert.match(h.updater.message, /1.0 MiB/);
  emit({ event: "Started", data: { contentLength: 1 } }); h.render();
  assert.equal(h.updater.percent, 100);
  finish(); await pending;
});

test("loose EXE failure explains its installation record instead of blaming the network", async () => {
  const h = harness({ installed: false });
  await h.updater.checkAndInstall(); h.render();
  assert.match(h.updater.message, /安装记录/);
  assert.doesNotMatch(h.updater.message, /网络|latest.json|签名/);
  assert.equal(h.updater.state.error, "");
  assert.equal(h.calls.includes("diagnose"), false);
});

test("opaque HTTP check failures are diagnosed without pretending every failure is a missing file", async () => {
  for (const [status, expected] of [[404, /latest.json.*404/], [403, /拒绝.*403/], [429, /频繁.*429/], [503, /503.*服务器/], [200, /未能获取有效/]]) {
    const h = harness({ checkError: "Could not fetch a valid release JSON from the remote", httpStatus: status });
    await h.updater.checkAndInstall(); h.render();
    assert.match(h.updater.message, expected);
    assert.deepEqual(h.calls, ["installed", "check", "diagnose"]);
    assert.equal(h.updater.busy, false);
  }
});

test("failed HTTP diagnosis reports only observed network facts and retains both errors", async () => {
  const h = harness({ checkError: "Could not fetch a valid release JSON from the remote", diagnosticError: "request timed out" });
  await h.updater.checkAndInstall(); h.render();
  assert.match(h.updater.message, /超时/);
  assert.doesNotMatch(h.updater.message, /404|不存在/);
  assert.match(h.updater.state.error, /valid release JSON/);
  assert.match(h.updater.state.error, /timed out/);
});

test("updater errors distinguish invalid manifests, platforms, certificates and unknown failures", async () => {
  for (const [error, expected] of [
    ['missing field `version`', /清单格式/],
    ['None of the fallback platforms `["windows-x86_64-nsis", "windows-x86_64"]` were found in the response `platforms` object', /系统或架构/],
    ["error sending request: invalid peer certificate: UnknownIssuer", /证书/],
    ["dns error: failed to lookup address", /域名解析/],
    ["error decoding response body", /读取或解析失败/],
    ["unrecognized check failure", /检查更新失败/],
  ]) {
    const h = harness({ checkError: error });
    await h.updater.checkAndInstall(); h.render();
    assert.match(h.updater.message, expected);
    assert.equal(h.updater.state.error, error);
    assert.equal(h.calls.includes("diagnose"), false);
  }
});

test("download and installation errors include actionable reasons and preserve technical details", async () => {
  for (const [error, expected, install] of [
    ["Download request failed with status: 404 Not Found", /安装包.*404/, false],
    ["The signature was created with a different key than the one provided", /签名密钥/, false],
    ["The signature verification failed", /签名校验/, false],
    ["The update was signed for version 0.4.7 but the update endpoint announced version 0.4.8", /版本.*不一致/, false],
    ["invalid updater binary format", /安装包.*无效/, true],
    ["Access is denied. (os error 5)", /权限/, true],
    ["There is not enough space on the disk. (os error 112)", /磁盘空间/, true],
    ["The operation was canceled by the user. (os error 1223)", /取消.*授权/, true],
    ["Invalid data. (os error 13)", /安装器/, true],
    ["Out of paper. (os error 28)", /安装器/, true],
  ]) {
    const h = harness(install ? { installError: error } : { download: async () => { throw error; } });
    await h.updater.checkAndInstall(); h.render();
    assert.match(h.updater.message, expected);
    assert.equal(h.updater.state.error, error);
    assert.equal(h.updater.busy, false);
    assert.equal(h.calls.includes("diagnose"), false);
  }
});

function renderAboutPanel(updater) {
  const compiled = ts.transpileModule(fs.readFileSync(new URL("../src/components/SettingsDialog.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  const mockRequire = (id) => {
    if (id === "react") return { useState: (value) => [value, () => {}], useEffect() {} };
    if (id === "react/jsx-runtime") return require(id);
    if (id === "../i18n") return i18nModule.exports;
    if (id === "../hooks/useEditorSettings") return { FONT_OPTIONS: [] };
    if (id === "../mascot/variants") return { MASCOT_VARIANTS: [] };
    if (id === "./MascotPortrait") return { __esModule: true, default: () => null };
    if (id.startsWith("@tauri-apps/")) return {};
    throw new Error(`Unexpected settings import: ${id}`);
  };
  // Expose the private panel only within this headless test evaluation.
  new Function("require", "module", "exports", compiled + "\nexports.AboutPanel = AboutPanel;")(mockRequire, module, module.exports);
  return module.exports.AboutPanel({ locale: "zh", contextMenu: false, updater });
}

function elementOfType(tree, type) {
  if (!tree) return null;
  if (Array.isArray(tree)) return tree.map((child) => elementOfType(child, type)).find(Boolean);
  return tree.type === type ? tree : elementOfType(tree.props?.children, type);
}

test("settings shows a specific error and keeps technical details collapsed by default", async () => {
  const h = harness({ checkError: "dns error: failed to lookup address" });
  await h.updater.checkAndInstall(); h.render();
  const panel = renderAboutPanel(h.updater);
  const details = elementOfType(panel, "details");
  assert.ok(details);
  assert.equal(details.props.open, undefined);
  assert.equal(elementOfType(details, "summary").props.children, "技术信息");
  assert.equal(elementOfType(details, "pre").props.children, h.updater.state.error);
});

test("known installation failure does not show duplicated technical or generic network advice", async () => {
  const h = harness({ installed: false });
  await h.updater.checkAndInstall(); h.render();
  const panel = renderAboutPanel(h.updater);
  assert.equal(elementOfType(panel, "details"), undefined);
  assert.match(h.updater.message, /没有匹配的安装记录/);
});
