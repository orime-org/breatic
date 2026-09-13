// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { execFileSync } from "node:child_process";
import type { LicensedPackage } from "#repo-lint/licence-coverage";

/**
 * What `pnpm licenses list --json` knows about the installed packages.
 *
 * One reader for the whole repository: the check that reconciles
 * `THIRD-PARTY.md` and the generator that writes the notice shipped to
 * browsers both ask this, so neither can read the tool differently from the
 * other.
 */

/** What the tool prints when it cannot answer. */
interface LicenceError {
  readonly error?: { readonly code?: string; readonly message?: string };
}

/**
 * The licence groups, or an error explaining why there are none.
 *
 * The dangerous shape is that a failure still prints valid JSON: measured,
 * a directory without a lockfile gets exit 1 and
 * `{"error":{"code":"ERR_PNPM_LICENSES_NO_LOCKFILE",...}}` on stdout. Parsing
 * that and walking its entries yields one group named "error" — or, written
 * defensively, no findings at all, which is this repository's forbidden
 * outcome: a check that reports clean because it had nothing to look at.
 * @param stdout - Whatever the tool printed.
 * @param failed - Whether it exited non-zero.
 * @returns The groups, when there are groups.
 * @throws {Error} When the tool could not answer.
 */
export function parseLicenceReport(
  stdout: string,
  failed: boolean,
): Record<string, LicensedPackage[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `pnpm licenses list printed no JSON. Run pnpm install first.\n${stdout.slice(0, 400)}`,
    );
  }
  const carried = (parsed as LicenceError).error;
  if (failed || carried !== undefined) {
    const said = carried?.message ?? stdout.slice(0, 400);
    throw new Error(`pnpm licenses list could not answer: ${said}`);
  }
  return parsed as Record<string, LicensedPackage[]>;
}

/**
 * Ask pnpm which packages are installed and under what licence.
 * @param repoRoot - Where to run it, so the answer covers this workspace.
 * @param workspacePackage - One workspace package to narrow the closure to.
 * @returns The licence groups.
 * @throws {Error} When the tool could not answer.
 */
export function readLicenceReport(
  repoRoot: string,
  workspacePackage?: string,
): Record<string, LicensedPackage[]> {
  const args = ["licenses", "list", "--json", "--prod"];
  if (workspacePackage !== undefined) args.push("--filter", workspacePackage);

  let stdout = "";
  let failed = false;
  try {
    stdout = execFileSync("pnpm", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    // pnpm writes its JSON to stdout even on the failing paths, so the
    // message it carries is worth more than the exit status alone.
    stdout = String((error as { stdout?: string }).stdout ?? "");
    failed = true;
  }

  return parseLicenceReport(stdout, failed);
}
