/**
 * Guards the i18n dictionary:
 *  1. every key exists in both languages (en / zh),
 *  2. no key is declared twice,
 *  3. every `t("...")` call in src/ resolves to a real key.
 *
 * Run with `npm run check:i18n`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const i18nPath = path.join(root, "src/i18n/index.ts");
const src = fs.readFileSync(i18nPath, "utf8");

function keysOf(dictName) {
  const start = src.indexOf(`const ${dictName}: Dict = {`);
  if (start === -1) throw new Error(`dictionary "${dictName}" not found`);
  const end = src.indexOf("\n};", start);
  const body = src.slice(start, end);
  return [...body.matchAll(/^\s{2}"([^"]+)":/gm)].map((m) => m[1]);
}

const en = keysOf("en");
const zh = keysOf("zh");
const known = new Set(en);

const dup = (list) => [...new Set(list.filter((k, i) => list.indexOf(k) !== i))];
const missingInZh = en.filter((k) => !zh.includes(k));
const missingInEn = zh.filter((k) => !en.includes(k));
const dupEn = dup(en);
const dupZh = dup(zh);

// --- 3. every t() call site uses a defined key ------------------------------
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const used = new Map(); // key -> [file, ...]
for (const file of walk(path.join(root, "src"))) {
  if (file === i18nPath) continue;
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/\bt\(\s*"([^"]+)"/g)) {
    const key = m[1];
    const rel = path.relative(root, file).replace(/\\/g, "/");
    if (!used.has(key)) used.set(key, []);
    if (!used.get(key).includes(rel)) used.get(key).push(rel);
  }
}

const unknown = [...used.keys()].filter((k) => !known.has(k)).sort();
const unused = en.filter((k) => !used.has(k)).sort();

console.log(`en keys: ${en.length} | zh keys: ${zh.length}`);
console.log("duplicates in en:", dupEn);
console.log("duplicates in zh:", dupZh);
console.log("missing in zh:", missingInZh);
console.log("missing in en:", missingInEn);
console.log("t() keys not in dictionary:", unknown.map((k) => `${k} (${used.get(k).join(", ")})`));
console.log("dictionary keys never used:", unused);

const ok =
  missingInZh.length === 0 &&
  missingInEn.length === 0 &&
  dupEn.length === 0 &&
  dupZh.length === 0 &&
  unknown.length === 0;

if (!ok) process.exitCode = 1;
