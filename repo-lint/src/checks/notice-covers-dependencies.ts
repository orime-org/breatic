// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { execFileSync } from "node:child_process";
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import {
  licenceCoverage,
  type LicensedPackage,
} from "#repo-lint/licence-coverage";

/**
 * The third-party notice accounts for every dependency that needs an entry.
 *
 * `THIRD-PARTY.md` states the rule in its own "Keeping this file current"
 * section; this runs it. What the rule covers is the npm half — the two
 * ffmpeg builds arrive through apt and apk and stay a manual read, which the
 * same section spells out.
 *
 * `--prod` is a manifest-section cut, and the rule asks about reaching a
 * published artefact. They are not the same window: `tw-animate-css` sits in
 * `packages/web`'s devDependencies and `packages/web/src/index.css` imports
 * it, so its CSS ships in the bundle and this check never sees it. Covering
 * the front-end half exactly means reading the built bundle.
 */

/** The file that both declares what we ship and registers these decisions. */
const NOTICE = "THIRD-PARTY.md";

/** What `pnpm licenses list --json` prints when it cannot answer. */
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

export const noticeCoversDependencies = {
  name: "notice-covers-dependencies",
  description: `Every non-permissive production dependency has an entry in ${NOTICE}`,
  run(context: CheckContext): Finding[] {
    let stdout = "";
    let failed = false;
    try {
      stdout = execFileSync("pnpm", ["licenses", "list", "--json", "--prod"], {
        cwd: context.repoRoot,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (error) {
      // pnpm writes its JSON to stdout even on the failing paths, so the
      // message it carries is worth more than the exit status alone.
      stdout = String((error as { stdout?: string }).stdout ?? "");
      failed = true;
    }

    const groups = parseLicenceReport(stdout, failed);
    const notice = context.read(NOTICE);

    return licenceCoverage(groups, notice).map((gap) => ({
      file: NOTICE,
      message:
        gap.reason === "missing"
          ? `"${gap.name}" ${gap.versions.join(", ")} is ${gap.licence} and ` +
            `reaches a published artefact, with no entry here. Add one, or ` +
            `decide the dependency under the collaboration spec's licence rule.`
          : `"${gap.name}" has an entry that does not state ${gap.licence}, ` +
            `which is what pnpm reports for the installed version. An entry ` +
            `naming a package says nothing true about it on its own.`,
    }));
  },
} satisfies Check;
