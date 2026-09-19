#!/usr/bin/env node
// Generates the `latest.json` that the Tauri updater reads, from the artifacts
// `tauri build` just produced.
//
//   npm run latest-json -- --notes "Fixed the selection highlight"
//
// The file lands next to the installers and is also printed to stdout. Upload it
// to the GitHub release as `latest.json` — the asset name matters, because the
// app always requests `<repo>/releases/latest/download/latest.json`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "MeteorKai/BetterNotepad";
/** Must match the Tauri target triple the app reports: `{os}-{arch}`. */
const TARGET = "windows-x86_64";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;

const setupName = `BetterNotepad_${version}_x64-setup.exe`;
const setupPath = join(bundleDir, setupName);
const sigPath = `${setupPath}.sig`;

if (!existsSync(setupPath)) {
  console.error(`Missing installer: ${setupPath}\nRun the build first.`);
  process.exit(1);
}

if (!existsSync(sigPath)) {
  console.error(
    `Missing signature: ${sigPath}\n\n` +
      "Tauri only writes .sig files when the signing key is available. The bundler\n" +
      "reads the key from TAURI_SIGNING_PRIVATE_KEY (the key *content*), so set both\n" +
      "variables before building:\n\n" +
      '  $note = "$env:USERPROFILE\\.tauri\\betternotepad.key.password.txt"\n' +
      "  $env:TAURI_SIGNING_PRIVATE_KEY = [System.IO.File]::ReadAllText(\"$env:USERPROFILE\\.tauri\\betternotepad.key\")\n" +
      "  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [regex]::Match(\n" +
      "      [System.IO.File]::ReadAllText($note), '(?m)^password:\\s*(.+?)\\s*$').Groups[1].Value\n" +
      "  npm run tauri build\n\n" +
      "Note: the .key.password.txt file is a human-readable note, NOT a bare password.\n" +
      "Passing it whole (or with Get-Content -Raw) makes the bundler fail with\n" +
      '"Wrong password for that key" AFTER the .exe is written — which is easy to miss,\n' +
      "because a stale .sig from an earlier build stays on disk. Always compare the\n" +
      "timestamps of the .exe and its .sig, and treat a non-zero exit as failure even\n" +
      "when the installer exists.\n\n" +
      "`TAURI_SIGNING_PRIVATE_KEY_PATH` only applies to `tauri signer sign`.\n"
  );
  process.exit(1);
}

const latest = {
  version,
  notes: arg("notes") ?? "",
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    [TARGET]: {
      signature: readFileSync(sigPath, "utf8").trim(),
      url: `https://github.com/${REPO}/releases/download/v${version}/${setupName}`,
    },
  },
};

const outPath = join(bundleDir, "latest.json");
writeFileSync(outPath, `${JSON.stringify(latest, null, 2)}\n`, "utf8");

console.log(`Wrote ${outPath}\n`);
console.log(JSON.stringify(latest, null, 2));
