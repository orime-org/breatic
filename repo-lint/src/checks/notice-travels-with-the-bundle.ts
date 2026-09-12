// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { buildLicenceNotice } from "#repo-lint/licence-notice";
import { readLicenceReport } from "#repo-lint/licence-report";

/**
 * The licence text that travels with the bundle matches the installed packages.
 *
 * MIT asks for its text in every copy of the software, and a browser receives
 * a copy on each visit. `SHIPPED` carries that text and reaches the browser
 * through `packages/web/public`, so it has to say what is actually installed.
 * A committed file cannot do that on its own: a dependency arrives, the file
 * stays as it was, and nothing says so. This regenerates it and compares.
 */

/** The generated notice, sitting where vite copies it into the bundle. */
const SHIPPED = "packages/web/public/third-party-licences.txt";

/** The workspace package whose production closure the notice covers. */
const COVERS = "@breatic/web";

/** How to put it right, named in the finding so nobody has to go looking. */
const REGENERATE = "pnpm --filter @breatic/repo-lint licences";

/**
 * How many packages a notice accounts for, read back from the notice itself.
 * @param notice - A notice, committed or freshly generated.
 * @returns The count of listed packages.
 */
function listedPackages(notice: string): number {
  const lines = notice.split("\n");
  const from = lines.indexOf("PACKAGES");
  if (from === -1) return 0;
  const to = lines.indexOf("LICENCE TEXTS");
  return lines
    .slice(from + 1, to === -1 ? undefined : to)
    .filter((line) => line.trim() !== "").length;
}

/**
 * What is wrong with the committed notice, when something is.
 * @param committed - The file in the repository, or undefined when absent.
 * @param current - What the installed packages produce right now.
 * @returns The message, or undefined when the two agree.
 */
export function compareShippedNotice(
  committed: string | undefined,
  current: string,
): string | undefined {
  if (committed === undefined) {
    return (
      `${SHIPPED} is missing, so the bundle ships no licence text at all. ` +
      `Generate it with: ${REGENERATE}`
    );
  }
  if (committed === current) return undefined;

  const held = listedPackages(committed);
  const produced = listedPackages(current);
  const how =
    held === produced
      ? `it lists the same ${held} packages, so what changed is the licence ` +
        `text one of them ships`
      : `it accounts for ${held} packages and the installed ones produce ${produced}`;

  return (
    `${SHIPPED} is out of date: ${how}. Whoever changed the dependencies ` +
    `owes this file the same change. Regenerate it with: ${REGENERATE}`
  );
}

export const noticeTravelsWithTheBundle = {
  name: "notice-travels-with-the-bundle",
  description: `${SHIPPED} matches the installed ${COVERS} packages`,
  run(context: CheckContext): Finding[] {
    const current = buildLicenceNotice(
      readLicenceReport(context.repoRoot, COVERS),
    );
    const committed = context.exists(SHIPPED)
      ? context.read(SHIPPED)
      : undefined;

    const said = compareShippedNotice(committed, current);
    return said === undefined ? [] : [{ file: SHIPPED, message: said }];
  },
} satisfies Check;
