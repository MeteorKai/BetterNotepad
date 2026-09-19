/**
 * One-off audit helper: flags UI strings still hard-coded in components, i.e.
 * literal `title=` / `placeholder=` / `aria-label=` attributes and bare JSX text
 * nodes that contain letters. Lines with `t(` are considered localised.
 *
 * Not part of the build; kept next to check-i18n.mjs because the same
 * "did every string actually get converted?" question comes up again.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Attributes that render user-visible text.
const ATTR = /\b(title|placeholder|aria-label)=("[^"]*"|'[^']*')/g;
// A JSX text node: `>some text<` on one line, letters, no braces/operators.
const TEXT_NODE = />([^<>{}=/()"'`]*[A-Za-z][^<>{}=/()"'`]*)</g;

const findings = [];

for (const file of walk(srcDir)) {
  const rel = path.relative(root, file).replace(/\\/g, "/");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    // Skip comment lines outright.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const m of line.matchAll(ATTR)) {
      const value = m[2].slice(1, -1);
      if (/[A-Za-z\u4e00-\u9fa5]/.test(value) && !/[{}]/.test(value)) {
        findings.push(`${rel}:${i + 1}  attr ${m[1]}="${value}"`);
      }
    }
    for (const m of line.matchAll(TEXT_NODE)) {
      const value = m[1].trim();
      // Ignore obvious code/JS-adjacent text and CSS-ish fragments.
      if (value.length < 2) continue;
      if (/[;:]|\bprintf\b|\bthen\b/.test(value)) continue;
      if (/^(Tauri|React|TypeScript|CodeMirror|Tailwind|Three|github\.com|©|Ctrl|Shift|Esc|Alt)\b/.test(value)) continue;
      findings.push(`${rel}:${i + 1}  text "${value}"`);
    }
  });
}

if (findings.length === 0) console.log("No hard-coded UI strings found.");
else {
  console.log(`${findings.length} candidate(s):`);
  for (const f of findings) console.log("  " + f);
}
