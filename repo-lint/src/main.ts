// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKS } from "#repo-lint/checks/index";
import { createContext } from "#repo-lint/context";
import { runChecks } from "#repo-lint/runner";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const results = await runChecks(CHECKS, createContext(repoRoot));

let failed = 0;
for (const result of results) {
  if (result.error !== undefined) {
    failed += 1;
    console.error(`\n✖ ${result.check.name} — could not run`);
    console.error(`  ${result.check.description}`);
    console.error(`  ${result.error.message}`);
    continue;
  }
  if (result.findings.length > 0) {
    failed += 1;
    console.error(
      `\n✖ ${result.check.name} — ${result.findings.length} problem(s)`,
    );
    console.error(`  ${result.check.description}`);
    for (const finding of result.findings) {
      const at = finding.line === undefined ? "" : `:${finding.line}`;
      console.error(`  ${finding.file}${at}  ${finding.message}`);
    }
  }
}

if (failed > 0) {
  console.error(`\nrepo-lint: ${failed} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`repo-lint: ${results.length} checks passed`);
