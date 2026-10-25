import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const THREE = require("three");
const compiled = ts.transpileModule(fs.readFileSync(new URL("../src/components/Mascot.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function load(relative, mockRequire = require, globals = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), compiled)(mockRequire, module, module.exports, ...Object.values(globals));
  return module.exports;
}
const variants = load("../src/mascot/variants.ts");
const Portrait = load("../src/components/MascotPortrait.tsx", (id) => id === "../mascot/variants" ? variants : require(id)).default;

// Use the real Three.js model, transforms and resources; only the renderer,
// browser events and React lifecycle are replaced for deterministic tests.
function harness({ failWebGL = false, initialPos = null, variant = "cat" } = {}) {
  let slots = [], cursor = 0, pending = [], clock = 1000, nextId = 0, tree;
  const cleanups = [], rafs = new Map(), timers = new Map();
  const listeners = { document: new Map(), window: new Map() };
  const saved = [], renderers = [];
  let hideCount = 0;
  const container = {
    appendChild(node) { node.parentElement = this; },
    removeChild(node) { node.parentElement = null; },
    setPointerCapture() {},
    getBoundingClientRect: () => ({ left: tree.props.style.left, top: tree.props.style.top }),
  };
  const events = (map) => ({
    addEventListener: (type, fn) => map.set(type, fn),
    removeEventListener: (type) => map.delete(type),
  });
  const document = {
    hidden: false, ...events(listeners.document),
    createElement: () => ({ getContext: () => ({
      createRadialGradient: () => ({ addColorStop() {} }), fillRect() {},
    }) }),
  };
  const window = {
    innerWidth: 1000, innerHeight: 800, devicePixelRatio: 3,
    ...events(listeners.window),
    setTimeout(fn) { const id = ++nextId; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  const react = {
    useRef(value) { const i = cursor++; return slots[i] ??= { current: i === 0 ? container : value }; },
    useState(value) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof value === "function" ? value() : value;
      return [slots[i], (v) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }];
    },
    useCallback: (fn) => fn,
    useEffect(fn, deps) {
      const i = cursor++, before = slots[i];
      if (!before || deps.some((value, j) => !Object.is(value, before[j]))) {
        pending.push(() => { cleanups[i]?.(); cleanups[i] = fn(); });
      }
      slots[i] = deps;
    },
  };
  class Renderer {
    constructor() {
      if (failWebGL) throw new Error("WebGL unavailable");
      this.domElement = {};
      this.renders = 0;
      renderers.push(this);
    }
    setClearColor(color, alpha) { this.alpha = alpha; }
    setPixelRatio(ratio) { this.ratio = ratio; }
    setSize(w, h) { this.size = [w, h]; }
    render(scene, camera) { this.scene = scene; this.camera = camera; this.renders++; }
    dispose() { this.disposed = true; }
    forceContextLoss() { this.contextLost = true; }
  }
  const mockRequire = (id) => {
    if (id === "react") return react;
    if (id === "three") return { ...THREE, WebGLRenderer: Renderer };
    if (id === "../hooks/useMascot") return { MASCOT_W: 150, MASCOT_H: 190 };
    if (id === "../i18n") return { t: (key) => key };
    if (id === "../mascot/variants") return variants;
    if (id === "./MascotPortrait") return { __esModule: true, default: Portrait };
    return require(id);
  };
  const module = { exports: {} };
  const math = Object.create(Math);
  math.random = () => 0;
  new Function("require", "module", "exports", "window", "document", "performance", "requestAnimationFrame", "cancelAnimationFrame", "Math", compiled)(
    mockRequire, module, module.exports, window, document, { now: () => clock },
    (fn) => { const id = ++nextId; rafs.set(id, fn); return id; }, (id) => rafs.delete(id), math,
  );
  const props = { variant, typingTick: 0, initialPos, onSavePos: (pos) => saved.push(pos), onHide: () => hideCount++ };
  const h = {
    document, window, listeners, rafs, timers, saved,
    get tree() { return tree; },
    get renderer() { return renderers.at(-1); },
    get hides() { return hideCount; },
    render(patch = {}) {
      Object.assign(props, patch); cursor = 0; pending = [];
      tree = module.exports.default(props);
      for (const run of pending) run();
      return tree;
    },
    frame(ms = 40) {
      clock += ms;
      const callbacks = [...rafs.values()]; rafs.clear();
      for (const fn of callbacks) fn(clock);
    },
    pointer(type, x, y) {
      tree.props[type]({ clientX: x, clientY: y, pointerId: 1, currentTarget: container });
    },
    unmount() { for (const cleanup of cleanups) cleanup?.(); },
  };
  h.render();
  if (failWebGL) h.render();
  else h.frame();
  return h;
}

const children = (h) => h.tree.props.children.flat().filter(Boolean);
const meshes = (scene) => { const list = []; scene.traverse((node) => { if (node.isMesh) list.push(node); }); return list; };

test("model uses a horizontal lighting ramp, shared geometry and a transparent canvas", () => {
  const h = harness();
  const all = meshes(h.renderer.scene);
  const ramp = all.find((mesh) => mesh.material.gradientMap).material.gradientMap;
  assert.equal(ramp.image.width, 32);
  assert.equal(ramp.image.height, 1);
  assert.ok(ramp.image.data[0] < ramp.image.data.at(-1));
  assert.ok(all.length > 20);
  assert.ok(new Set(all.map((mesh) => mesh.geometry)).size < 10);
  assert.equal(h.renderer.alpha, 0);
  assert.equal(h.renderer.ratio, 2);
  assert.deepEqual(h.renderer.size, [150, 190]);
  h.unmount();
});

for (const variant of variants.MASCOT_VARIANTS) test(`${variant}: idle, wave and click animations stay inside the canvas without NaN transforms`, () => {
  const h = harness({ variant });
  for (let frame = 0; frame < 400; frame++) {
    if (frame === 20) h.pointer("onPointerUp", 500, 500);
    if (frame === 40) {
      h.pointer("onPointerDown", 500, 500);
      h.pointer("onPointerUp", 500, 500);
    }
    h.frame();
    h.renderer.scene.updateMatrixWorld(true);
    h.renderer.camera.updateMatrixWorld(true);
    for (const mesh of meshes(h.renderer.scene)) {
      const bounds = new THREE.Box3().setFromObject(mesh);
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const projected = new THREE.Vector3(x, y, z).project(h.renderer.camera);
        assert.ok(Number.isFinite(projected.x) && Number.isFinite(projected.y));
        assert.ok(Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1, `clipped at frame ${frame}`);
      }
    }
  }
  h.unmount();
});

test("eye highlights blink together with the eyes, rather than floating outside them", () => {
  const h = harness();
  const eyeGroups = [];
  h.renderer.scene.traverse((node) => {
    if (node.isGroup && node.children.length === 3 && node.children.every((child) => child.isMesh && child.material.isMeshBasicMaterial)) eyeGroups.push(node);
  });
  assert.equal(eyeGroups.length, 2);
  h.frame(1960); // Start the deterministic blink at t=3000.
  h.frame(90);
  for (const eye of eyeGroups) {
    assert.ok(eye.scale.y < 0.1);
    assert.equal(eye.children[1].parent, eye);
  }
  h.frame(100);
  assert.equal(eyeGroups[0].scale.y, 1);
  h.unmount();
});

test("rendering is capped at 30fps and pauses while the document is hidden", () => {
  const h = harness();
  const before = h.renderer.renders;
  h.frame(10); h.frame(10); h.frame(10);
  assert.equal(h.renderer.renders, before);
  h.frame(10);
  assert.equal(h.renderer.renders, before + 1);
  h.document.hidden = true;
  h.listeners.document.get("visibilitychange")();
  assert.equal(h.rafs.size, 0);
  h.frame(500);
  assert.equal(h.renderer.renders, before + 1);
  h.document.hidden = false;
  h.listeners.document.get("visibilitychange")();
  h.frame();
  assert.equal(h.renderer.renders, before + 2);
  h.unmount();
});

test("click and keyboard activation show feedback, while the close button does not drag", () => {
  const h = harness();
  h.pointer("onPointerDown", 500, 500);
  h.pointer("onPointerUp", 500, 500);
  h.render();
  assert.ok(children(h).some((node) => node.type === "div"));
  assert.equal(h.timers.size, 1);
  const [actor, close] = children(h).filter((node) => node.type === "button");
  actor.props.onClick({ detail: 0 });
  assert.equal(h.timers.size, 1);
  let stopped = false;
  close.props.onPointerDown({ stopPropagation() { stopped = true; } });
  close.props.onClick();
  assert.ok(stopped);
  assert.equal(h.hides, 1);
  h.unmount();
});

test("dragging persists the position without click feedback and resize keeps the corner offset", () => {
  const h = harness({ initialPos: { x: 700, y: 500 } });
  h.pointer("onPointerDown", 750, 550);
  h.pointer("onPointerMove", 650, 450);
  h.render();
  h.pointer("onPointerUp", 650, 450);
  assert.deepEqual(h.saved, [{ x: 600, y: 400 }]);
  assert.equal(h.timers.size, 0);
  h.window.innerWidth = 800; h.window.innerHeight = 600;
  h.listeners.window.get("resize")(); h.render();
  assert.equal(h.tree.props.style.left, 400);
  assert.equal(h.tree.props.style.top, 200);
  h.unmount();
});

test("cleanup disposes every shared resource once and leaves no animation or timer behind", () => {
  const h = harness();
  const resources = new Set();
  for (const mesh of meshes(h.renderer.scene)) {
    resources.add(mesh.geometry); resources.add(mesh.material);
    if (mesh.material.map) resources.add(mesh.material.map);
    if (mesh.material.gradientMap) resources.add(mesh.material.gradientMap);
  }
  const counts = new Map();
  for (const resource of resources) resource.addEventListener("dispose", () => counts.set(resource, (counts.get(resource) ?? 0) + 1));
  h.pointer("onPointerDown", 500, 500); h.pointer("onPointerUp", 500, 500);
  h.unmount();
  for (const resource of resources) assert.equal(counts.get(resource), 1);
  assert.equal(h.rafs.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.document.size, 0);
  assert.equal(h.listeners.window.size, 0);
  assert.ok(h.renderer.disposed);
  assert.equal(h.renderer.domElement.parentElement, null);
});

test("WebGL fallback keeps the cat, interaction, dragging and hide controls", () => {
  const h = harness({ failWebGL: true });
  const portrait = children(h).find((node) => node.type === Portrait);
  assert.equal(portrait.props.variant, "cat");
  assert.equal(Portrait(portrait.props).type, "svg");
  assert.equal(children(h).filter((node) => node.type === "button").length, 2);
  h.pointer("onPointerDown", 500, 500); h.pointer("onPointerUp", 500, 500); h.render();
  assert.equal(h.timers.size, 1);
  children(h).filter((node) => node.type === "button")[1].props.onClick();
  assert.equal(h.hides, 1);
  h.unmount();
});

test("switching repeatedly keeps position and releases the previous model, RAF and GPU context", () => {
  const h = harness({ initialPos: { x: 500, y: 300 } });
  for (let i = 0; i < 20; i++) {
    const previous = h.renderer;
    const resources = new Set();
    for (const mesh of meshes(previous.scene)) { resources.add(mesh.geometry); resources.add(mesh.material); }
    const disposed = new Set();
    for (const resource of resources) resource.addEventListener("dispose", () => disposed.add(resource));
    const variant = variants.MASCOT_VARIANTS[(i + 1) % 4];
    h.render({ variant }); h.frame();
    assert.notEqual(h.renderer, previous);
    assert.ok(previous.disposed && previous.contextLost);
    assert.equal(previous.domElement.parentElement, null);
    assert.equal(disposed.size, resources.size);
    assert.equal(h.rafs.size, 1);
    assert.equal(h.tree.props.style.left, 500);
    assert.equal(h.tree.props.style.top, 300);
    const color = meshes(h.renderer.scene).find((mesh) => mesh.material.gradientMap).material.color.getHexString();
    assert.equal(`#${color}`, variants.MASCOT_PALETTES[variant].body);
  }
  h.unmount();
});

test("each WebGL fallback displays the selected portrait", () => {
  const h = harness({ failWebGL: true });
  for (const variant of variants.MASCOT_VARIANTS) {
    h.render({ variant }); h.render();
    const portrait = children(h).find((node) => node.type === Portrait);
    assert.equal(portrait.props.variant, variant);
    assert.equal(Portrait(portrait.props).type, "svg");
  }
  h.unmount();
});

function preferenceHarness(value, storageBlocked = false) {
  const storage = new Map(value === undefined ? [] : [["betternotepad.mascot.variant", value]]);
  let slots = [], cursor = 0, pending = [], mascot;
  const react = {
    useState(value) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof value === "function" ? value() : value;
      return [slots[i], (v) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }];
    },
    useCallback: (fn) => fn,
    useEffect(fn, deps) {
      const i = cursor++, before = slots[i];
      if (!before || deps.some((v, j) => !Object.is(v, before[j]))) pending.push(fn);
      slots[i] = deps;
    },
  };
  const localStorage = {
    getItem(key) { if (storageBlocked) throw new Error("blocked"); return storage.get(key) ?? null; },
    setItem(key, value) { if (storageBlocked) throw new Error("blocked"); storage.set(key, value); },
  };
  const hook = load("../src/hooks/useMascot.ts", (id) => id === "react" ? react : variants, { localStorage }).useMascot;
  const render = () => { cursor = 0; pending = []; mascot = hook(); for (const run of pending) run(); return mascot; };
  render();
  return { render, get mascot() { return mascot; }, storage };
}

test("choice is persisted and restored for each mascot, separately from visibility and position", () => {
  for (const variant of variants.MASCOT_VARIANTS) {
    const h = preferenceHarness();
    assert.equal(h.mascot.variant, "cat");
    h.mascot.setVariant(variant); h.render();
    assert.equal(h.storage.get("betternotepad.mascot.variant"), variant);
    h.mascot.toggle(); h.render();
    assert.equal(h.mascot.visible, false);
    assert.equal(h.mascot.variant, variant);
    assert.equal(h.storage.has("betternotepad.mascot.pos"), false);
    assert.equal(preferenceHarness(h.storage.get("betternotepad.mascot.variant")).mascot.variant, variant);
  }
});

test("old settings, invalid stored variants and restricted storage safely use the default cat", () => {
  for (const value of [undefined, "", "unknown", "CAT", "null", "[\"cat\"]"]) {
    assert.equal(preferenceHarness(value).mascot.variant, "cat");
  }
  const h = preferenceHarness("rabbit", true);
  assert.equal(h.mascot.variant, "cat");
  h.mascot.setVariant("fox"); h.render();
  assert.equal(h.mascot.variant, "fox");
});

test("every selectable mascot has translated names and descriptions in both languages", () => {
  const i18n = load("../src/i18n/index.ts");
  for (const locale of ["zh", "en"]) {
    i18n.setI18nLocale(locale);
    for (const variant of variants.MASCOT_VARIANTS) for (const field of ["name", "description"]) {
      const key = `mascot.${variant}.${field}`;
      assert.notEqual(i18n.t(key), key);
    }
  }
});

test("settings picker has four lightweight previews and selects without enabling a hidden mascot", () => {
  const compiled = ts.transpileModule(fs.readFileSync(new URL("../src/components/SettingsDialog.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  const mockRequire = (id) => {
    if (id === "react") return {};
    if (id === "../mascot/variants") return variants;
    if (id === "./MascotPortrait") return { __esModule: true, default: Portrait };
    if (id === "../i18n") return { t: (key) => key };
    if (id === "../hooks/useEditorSettings" || id.startsWith("@tauri-apps/")) return {};
    return require(id);
  };
  new Function("require", "module", "exports", compiled + "\nexports.panel = MascotSettingsPanel;")(mockRequire, module, module.exports);
  const h = preferenceHarness();
  h.mascot.toggle(); h.render();
  const panel = module.exports.panel({ mascot: h.mascot });
  const cards = panel.props.children.find((node) => node.props?.role === "group").props.children;
  assert.equal(cards.length, 4);
  assert.equal(cards.filter((card) => card.props["aria-pressed"]).length, 1);
  for (const card of cards) {
    assert.ok(card.props.children.some((node) => node?.type === Portrait));
    card.props.onClick(); h.render();
    assert.equal(h.mascot.variant, card.key);
    assert.equal(h.mascot.visible, false);
  }
});
