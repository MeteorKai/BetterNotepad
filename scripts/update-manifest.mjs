import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function readReleaseVersion(root) {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const version = JSON.parse(read("package.json")).version;
  const lock = JSON.parse(read("package-lock.json"));
  const versions = [lock.version, lock.packages[""].version, JSON.parse(read("src-tauri/tauri.conf.json")).version,
    read("src-tauri/Cargo.toml").match(/^version = "([^"]+)"/m)?.[1],
    read("src-tauri/Cargo.lock").match(/\[\[package\]\]\r?\nname = "notepad-app"\r?\nversion = "([^"]+)"/)?.[1]];
  if (!stableVersion.test(version) || versions.some((value) => value !== version)) {
    throw new Error("All app version fields must match a stable x.y.z release version.");
  }
  return version;
}

export function setReleaseVersion(root, version) {
  if (!stableVersion.test(version)) throw new Error("Use a stable x.y.z version, for example 0.4.7.");
  readReleaseVersion(root);
  for (const file of ["package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
    const fullPath = path.join(root, file);
    const original = fs.readFileSync(fullPath, "utf8");
    let updated;
    if (file === "src-tauri/Cargo.lock") {
      updated = original.replace(/(\[\[package\]\]\r?\nname = "notepad-app"\r?\nversion = ")[^"]+(")/, `$1${version}$2`);
    } else if (file.endsWith(".toml")) {
      updated = original.replace(/^version = "[^"]+"/m, `version = "${version}"`);
    } else {
      updated = original.replace(/^(  "version": ")[^"]+(")/m, `$1${version}$2`);
      if (file === "package-lock.json") {
        updated = updated.replace(/("": \{\r?\n\s+"name": "[^"]+",\r?\n\s+"version": ")[^"]+(")/, `$1${version}$2`);
      }
    }
    fs.writeFileSync(fullPath, updated);
  }
  return readReleaseVersion(root);
}

export function writeUpdateManifest(root, bundleDir, now = new Date()) {
  const version = readReleaseVersion(root);
  const name = `BetterNotepad_${version}_x64-setup.exe`;
  if (fs.statSync(path.join(bundleDir, name)).size === 0) throw new Error("The installer is empty.");
  const signature = fs.readFileSync(path.join(bundleDir, `${name}.sig`), "utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) ||
      !Buffer.from(signature, "base64").toString("utf8").startsWith("untrusted comment:")) {
    throw new Error("The installer .sig is missing or is not a Tauri signature.");
  }
  const manifest = {
    version, notes: `BetterNotepad ${version}`, pub_date: now.toISOString(),
    platforms: { "windows-x86_64": {
      signature, url: `https://github.com/MeteorKai/BetterNotepad/releases/download/v${version}/${name}`,
    } },
  };
  const destination = path.join(bundleDir, "latest.json");
  fs.writeFileSync(destination, JSON.stringify(manifest, null, 2) + "\n");
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    if (process.argv[2] === "--set-version") console.log(`Release version: ${setReleaseVersion(root, process.argv[3] ?? "")}`);
    else if (process.argv[2] === "--check") console.log(`Release version: ${readReleaseVersion(root)}`);
    else console.log(writeUpdateManifest(root, path.resolve(process.argv[2] ?? "src-tauri/target/release/bundle/nsis")));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
