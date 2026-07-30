// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/** A package manifest, as far as this check reads one. */
interface Manifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly scripts?: Record<string, string>;
}

/**
 * Every workspace package runs the linter.
 *
 * The rules live in one shared plugin, but reaching a file is per package:
 * the linter runs once per `lint` script, so a package without one is a
 * package none of the rules apply to. Nothing else notices. The repository
 * would still build, still typecheck, still pass every other check, and
 * the mandated rules — licence headers, no relative imports, no logger in
 * a library, no environment access in a library — would simply stop
 * applying there.
 *
 * That is the shape of failure worth guarding: not a rule that reports the
 * wrong thing, which someone sees, but a rule that reports nothing, which
 * looks exactly like passing. So the opt-in is made non-deletable rather
 * than left to memory.
 *
 * What scope each package should lint is a separate question, tracked
 * separately; this only requires that some scope is linted.
 */
export const lintCoverage = {
  name: "lint-coverage",
  description: "Every workspace package runs the linter",
  run(context: CheckContext): Finding[] {
    const manifests = context.files(
      (path) =>
        /^(packages\/[^/]+|eslint-rules|repo-lint)\/package\.json$/.test(path),
      "workspace package manifests",
    );

    const findings: Finding[] = [];
    for (const file of manifests) {
      const manifest = JSON.parse(context.read(file)) as Manifest;
      const script = manifest.scripts?.["lint"];
      if (script === undefined) {
        findings.push({
          file,
          message:
            "this package has no `lint` script, so none of the shared rules run against it. A package the linter never visits looks exactly like a package with no violations.",
        });
        continue;
      }
      if (!/\beslint\b/.test(script)) {
        findings.push({
          file,
          message: `its \`lint\` script is \`${script}\`, which does not run eslint — the shared rules are enforced by eslint alone, so nothing enforces them here.`,
        });
      }
    }
    return findings;
  },
} satisfies Check;
