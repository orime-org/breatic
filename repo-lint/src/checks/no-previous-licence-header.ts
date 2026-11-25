// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * The SPDX line the repository carried before it moved to the Breatic
 * Source-Available License 2.0, built from pieces so this file does not match
 * itself.
 */
const PREVIOUS = "SPDX-License-Identifier: " + "AGPL-3.0-only";

/**
 * No tracked file carries the previous licence's SPDX line.
 *
 * The header rule in eslint-rules covers only some directories, and branches
 * cut before the change add files by copying an existing header. Without this,
 * a file under `packages/web/tests`, `packages/ingest`, `scripts/` or the SQL
 * migrations would bring the old licence line back and CI would stay green.
 */
export const noPreviousLicenceHeader = {
  name: "no-previous-licence-header",
  description: "No tracked file carries the previous licence's SPDX line",
  run(context: CheckContext): Finding[] {
    const findings: Finding[] = [];
    for (const file of context.textFiles(() => true, "readable tracked files")) {
      const lines = context.read(file).split("\n");
      lines.forEach((line, index) => {
        if (line.includes(PREVIOUS)) {
          findings.push({
            file,
            line: index + 1,
            message: "Carries the previous licence line; use SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0.",
          });
        }
      });
    }
    return findings;
  },
} satisfies Check;
