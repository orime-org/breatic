// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * The long-running services and where each one starts.
 *
 * Named literally because that is the assertion: these paths exist. A glob
 * would find whatever is there and say nothing about what is missing.
 */
const SERVICE_ENTRIES: ReadonlyMap<string, string> = new Map([
  ["server", "packages/server/src/index.ts"],
  ["worker", "packages/worker/src/index.ts"],
  ["collab", "packages/collab/src/index.ts"],
]);

/**
 * Every long-running service still has an entry point.
 *
 * The other half of this invariant — that each entry wires a logger and a
 * health server — is an ESLint rule, because it is a question about one
 * file's code. This half cannot be: a deleted or renamed entry is a file
 * that never gets linted, so the rule would simply never run and the
 * absence would read as clean. That is the exact failure shape the whole
 * observability mandate exists to prevent, so it gets its own assertion
 * rather than an assumption.
 */
export const serviceEntriesPresent = {
  name: "service-entries-present",
  description: "Every long-running service still has an entry point",
  run(context: CheckContext): Finding[] {
    const findings: Finding[] = [];
    for (const [service, entry] of SERVICE_ENTRIES) {
      if (!context.exists(entry)) {
        findings.push({
          file: entry,
          message: `The ${service} service has no entry point here. If it moved, move this expectation with it — the rule that checks its logger and health wiring is keyed on this path, and a file that does not exist is a file nothing lints.`,
        });
      }
    }
    return findings;
  },
} satisfies Check;
