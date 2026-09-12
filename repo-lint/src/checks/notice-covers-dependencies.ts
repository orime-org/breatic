// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { licenceCoverage } from "#repo-lint/licence-coverage";
import { readLicenceReport } from "#repo-lint/licence-report";

/**
 * The third-party notice accounts for every dependency that needs an entry.
 *
 * `THIRD-PARTY.md` states the rule in its own "Keeping this file current"
 * section; this runs it. What the rule covers is the npm half — the two
 * ffmpeg builds arrive through apt and apk and stay a manual read, which the
 * same section spells out.
 *
 * `--prod` is a manifest-section cut, and the rule asks about reaching a
 * published artefact. The two windows line up only because every package
 * whose bytes reach the bundle is declared as a dependency, which
 * `dependencies-declare-what-ships` holds to.
 */

/** The file that both declares what we ship and registers these decisions. */
const NOTICE = "THIRD-PARTY.md";

export const noticeCoversDependencies = {
  name: "notice-covers-dependencies",
  description: `Every non-permissive production dependency has an entry in ${NOTICE}`,
  run(context: CheckContext): Finding[] {
    const groups = readLicenceReport(context.repoRoot);
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
