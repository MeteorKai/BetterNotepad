import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readReleaseVersion, setReleaseVersion, writeUpdateManifest } from "./update-manifest.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "betternotepad-manifest-"));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("betternotepad-manifest-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "src-tauri"));
  const write = (file, data) => fs.writeFileSync(path.join(root, file), typeof data === "string" ? data : JSON.stringify(data, null, 2));
  write("package.json", { name: "betternotepad", version: "0.4.6" });
  write("package-lock.json", { version: "0.4.6", packages: { "": { name: "betternotepad", version: "0.4.6" }, dependency: { version: "0.4.6" } } });
  write("src-tauri/tauri.conf.json", { version: "0.4.6" });
  write("src-tauri/Cargo.toml", '[package]\nname = "notepad-app"\nversion = "0.4.6"\n[dependencies]\ndep = "0.4.6"\n');
  write("src-tauri/Cargo.lock", '[[package]]\nname = "dependency"\nversion = "0.4.6"\n\n[[package]]\nname = "notepad-app"\nversion = "0.4.6"\n');
  const bundle = path.join(root, "bundle with spaces");
  fs.mkdirSync(bundle);
  const installer = path.join(bundle, "BetterNotepad_0.4.6_x64-setup.exe");
  fs.writeFileSync(installer, "test payload, not an executable");
  const signature = Buffer.from("untrusted comment: test signature\n").toString("base64");
  fs.writeFileSync(`${installer}.sig`, signature + "\n");
  return { root, bundle, installer, signature, write };
}

test("manifest selects Windows x64 and the exact versioned GitHub asset", (t) => {
  const f = fixture(t);
  const result = JSON.parse(fs.readFileSync(writeUpdateManifest(f.root, f.bundle, new Date("2026-10-12T00:00:00Z")), "utf8"));
  assert.equal(result.version, "0.4.6");
  assert.equal(result.pub_date, "2026-10-12T00:00:00.000Z");
  assert.equal(result.platforms["windows-x86_64"].signature, f.signature);
  assert.equal(result.platforms["windows-x86_64"].url, "https://github.com/MeteorKai/BetterNotepad/releases/download/v0.4.6/BetterNotepad_0.4.6_x64-setup.exe");
});

test("empty/missing installer and absent/placeholder signature cannot publish a manifest", (t) => {
  const f = fixture(t);
  fs.writeFileSync(`${f.installer}.sig`, "");
  assert.throws(() => writeUpdateManifest(f.root, f.bundle), /signature/);
  fs.rmSync(`${f.installer}.sig`);
  assert.throws(() => writeUpdateManifest(f.root, f.bundle), /ENOENT/);
  fs.writeFileSync(f.installer, "");
  assert.throws(() => writeUpdateManifest(f.root, f.bundle), /empty/);
  fs.rmSync(f.installer);
  assert.throws(() => writeUpdateManifest(f.root, f.bundle), /ENOENT/);
  assert.equal(fs.existsSync(path.join(f.bundle, "latest.json")), false);
});

test("version mismatch is rejected before generating release metadata", (t) => {
  const f = fixture(t);
  f.write("src-tauri/tauri.conf.json", { version: "0.4.5" });
  assert.throws(() => writeUpdateManifest(f.root, f.bundle), /version fields/);
});

test("release version updates only app fields, not dependency versions", (t) => {
  const f = fixture(t);
  assert.equal(setReleaseVersion(f.root, "0.4.7"), "0.4.7");
  const lock = JSON.parse(fs.readFileSync(path.join(f.root, "package-lock.json"), "utf8"));
  assert.equal(lock.packages.dependency.version, "0.4.6");
  const cargoLock = fs.readFileSync(path.join(f.root, "src-tauri/Cargo.lock"), "utf8");
  assert.match(cargoLock, /name = "dependency"\nversion = "0.4.6"/);
  assert.match(fs.readFileSync(path.join(f.root, "src-tauri/Cargo.toml"), "utf8"), /dep = "0.4.6"/);
  assert.equal(readReleaseVersion(f.root), "0.4.7");
});

test("invalid and prerelease versions do not mutate source files", (t) => {
  const f = fixture(t);
  for (const version of ["v0.4.7", "0.4", "00.4.7", "0.4.7-beta.1", "1.2.3\n", ""]) {
    assert.throws(() => setReleaseVersion(f.root, version), /stable/);
    assert.equal(readReleaseVersion(f.root), "0.4.6");
  }
});

test("version update accepts major versions and CRLF without changing Cargo's lock header", (t) => {
  const f = fixture(t);
  for (const file of ["package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
    const full = path.join(f.root, file);
    fs.writeFileSync(full, fs.readFileSync(full, "utf8").replaceAll("\n", "\r\n"));
  }
  assert.equal(setReleaseVersion(f.root, "10.20.30"), "10.20.30");
});
