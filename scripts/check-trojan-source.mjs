// check-trojan-source — scan the file paths fed on stdin for Trojan Source
// attacks (CVE-2021-42574): bidirectional-override and invisible control
// characters that make the source a human reviewer sees differ from what
// the compiler / interpreter parses.
//
// This calls anti-trojan-source's public `hasConfusablesInFiles` API (the
// package's `exports["."]` entry) directly, NOT its `bin/` CLI. The CLI
// unconditionally calls `process.stdin.unref()`, which throws on Node 24
// whenever stdin is a file / /dev/null (an fs.ReadStream has no `unref`) —
// i.e. in CI and in any non-piped invocation. The detection logic lives in
// the library; we use that and skip the broken wrapper.
//
// extended:false keeps the scan to the dangerous Cf/Cc subset (bidi +
// invisible). Ordinary non-ASCII text — CJK, accents, typography such as
// — → ≤ ✓ — is NOT flagged; that readability concern is owned by the
// separate lint:no-cjk guard.
//
// Input: newline-delimited file paths on stdin (the wrapper builds the list
// via `git ls-files`). Exit 1 with a report on any finding, 0 when clean.

import { readFileSync } from "node:fs";
import { hasConfusablesInFiles } from "anti-trojan-source";

// Read fd 0 directly (no stream, no .unref()) so this is robust across Node
// versions regardless of whether stdin is a pipe, a file, or /dev/null.
let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch {
  raw = "";
}

const filePaths = raw
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

if (filePaths.length === 0) {
  console.log("lint:no-trojan-source — no files to scan");
  process.exit(0);
}

const rawResults = await hasConfusablesInFiles({
  filePaths,
  detailed: true,
  extended: false,
});

// Drop emoji variation selectors (U+FE00..U+FE0F, category "Variation
// Selector"). They are invisible, so the library flags them, but they are
// definitionally OUTSIDE the Trojan Source threat model: a variation
// selector only changes how a preceding emoji renders and cannot appear in
// an identifier (not ID_Continue), so it cannot hide code logic from
// review. The codebase uses ⚠️ / ✅ / 🖼️ legitimately in docs and UI; the
// dangerous bidi-control and zero-width/invisible chars are kept.
const results = (rawResults || [])
  .map((result) => ({
    ...result,
    findings: result.findings.filter(
      (finding) => finding.category !== "Variation Selector",
    ),
  }))
  .filter((result) => result.findings.length > 0);

if (results.length > 0) {
  console.error(
    "lint:no-trojan-source — Trojan Source / dangerous Unicode detected:",
  );
  console.error("");
  for (const result of results) {
    for (const finding of result.findings) {
      console.error(
        `${result.file}:${finding.line}:${finding.column}  ${finding.codePoint} ${finding.name} [${finding.severity}] [${finding.category}]`,
      );
    }
  }
  console.error("");
  console.error(
    "These are bidi-control / invisible characters (CVE-2021-42574 Trojan",
  );
  console.error(
    "Source) — the code you read is not the code that runs. Remove them.",
  );
  console.error(
    "Ordinary non-ASCII text (CJK / accents / — → ≤) is NOT flagged here.",
  );
  process.exit(1);
}

console.log(
  `lint:no-trojan-source — clean (${filePaths.length} files, no bidi/invisible Trojan Source chars)`,
);
process.exit(0);
