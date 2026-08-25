// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKS } from "#repo-lint/checks/index";
import { createContext } from "#repo-lint/context";
import { runChecks } from "#repo-lint/runner";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Named checks run alone. A CI job that installs dependencies but does not
// build cannot run the check that reads build output, and a job that exists
// to guard one invariant should say which. An unknown name is a hard error:
// a renamed check must not quietly stop running in the job that names it,
// which is the whole failure mode this suite was rewritten to remove.
const requested = process.argv.slice(2);
const unknown = requested.filter(
  (name) => !CHECKS.some((check) => check.name === name),
);
if (unknown.length > 0) {
  console.error(
    `repo-lint: no such check: ${unknown.join(", ")}\n` +
      `available: ${CHECKS.map((check) => check.name).join(", ")}`,
  );
  process.exit(2);
}
const selected =
  requested.length === 0
    ? CHECKS
    : CHECKS.filter((check) => requested.includes(check.name));

const results = await runChecks(selected, createContext(repoRoot));

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
