// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/** What running one check produced. */
export interface CheckResult {
  /** The check that ran. */
  readonly check: Check;
  /** What it found, empty when clean or when it could not run. */
  readonly findings: readonly Finding[];
  /** Why it could not run, absent when it ran. */
  readonly error?: Error;
}

/**
 * Runs every check, keeping going after one fails.
 *
 * A throwing check is recorded as a failure rather than allowed to end the
 * run: one broken check must not hide the verdicts of the others, and it
 * must not be mistaken for a pass either.
 * @param checks The checks to run.
 * @param context What to run them against.
 * @returns One result per check, in the order given.
 */
export async function runChecks(
  checks: readonly Check[],
  context: CheckContext,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      results.push({ check, findings: await check.run(context) });
    } catch (error) {
      results.push({
        check,
        findings: [],
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return results;
}
