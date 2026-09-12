// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * Every package the shipped source imports is declared as a dependency.
 *
 * `pnpm licenses list --prod` decides who owes a licence entry by reading the
 * manifest, while the obligation attaches to whatever bytes reach a recipient.
 * The two windows line up only if the manifest says what ships. Measured when
 * this went in: `tailwindcss` and `tw-animate-css` sat in devDependencies with
 * their CSS in the bundle, so the notice named neither, and MIT asks for its
 * text in every copy.
 *
 * Reads stylesheets as well as TypeScript, which is the half a JavaScript
 * linter structurally cannot see — and the half both of those packages
 * arrived through.
 */

/** Where published artefacts are built from. The guard packages sit outside. */
const SHIPPED = /^packages\/[^/]+\/src\//;

/** Files whose imports serve the tests rather than the artefact. */
const FOR_TESTS = /__tests__\/|\.test\.|\.spec\.|\/tests\/|\/test-utils\/|\.config\./;

/** Every way the sources name another package. */
const IMPORTS =
  /(?:from\s*|import\s*|@import\s*|require\(\s*)['"]([^'".][^'"]*)['"]/g;

/** Prefixes that name something other than an installed package. */
const NOT_A_PACKAGE = /^(@\/|#|node:|@breatic\/|@web\/|@shared\/|@core\/|@domain\/|@server\/|@worker\/|@collab\/)/;

/**
 * The installed package an import specifier names.
 * @param specifier - What the source wrote between the quotes.
 * @returns The package name, keeping the scope of a scoped one.
 */
function packageNamed(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/**
 * The manifest governing a source file, by longest matching directory.
 * @param path - The source file.
 * @param manifests - Every manifest, keyed by the directory it governs.
 * @returns The directory, when one governs this file.
 */
function governedBy(
  path: string,
  manifests: readonly string[],
): string | undefined {
  return manifests.find((directory) => path.startsWith(`${directory}/src/`));
}

export const dependenciesDeclareWhatShips = {
  name: "dependencies-declare-what-ships",
  description:
    "Packages imported by shipped source are declared as dependencies",
  run(context: CheckContext): Finding[] {
    const manifests = context
      .files(
        (path) => /^packages\/[^/]+\/package\.json$/.test(path),
        "package manifests",
      )
      .map((path) => path.slice(0, -"/package.json".length))
      .sort((a, b) => b.length - a.length);

    const sources = context.files(
      (path) =>
        SHIPPED.test(path) &&
        !FOR_TESTS.test(path) &&
        /\.(ts|tsx|mts|cts|css)$/.test(path),
      "shipped source files",
    );

    const findings: Finding[] = [];
    const reported = new Set<string>();

    for (const path of sources) {
      const directory = governedBy(path, manifests);
      if (directory === undefined) continue;

      const manifest = JSON.parse(context.read(`${directory}/package.json`)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const declared = new Set(Object.keys(manifest.dependencies ?? {}));
      const forDevelopment = new Set(
        Object.keys(manifest.devDependencies ?? {}),
      );

      for (const match of context.read(path).matchAll(IMPORTS)) {
        const specifier = match[1];
        if (specifier === undefined || NOT_A_PACKAGE.test(specifier)) continue;
        const name = packageNamed(specifier);
        if (declared.has(name) || !forDevelopment.has(name)) continue;

        const seen = `${directory} ${name}`;
        if (reported.has(seen)) continue;
        reported.add(seen);

        findings.push({
          file: `${directory}/package.json`,
          message:
            `"${name}" is a devDependency, and ${path} imports it, so its ` +
            `code reaches the published artefact. Move it to dependencies: ` +
            `the licence notice is generated from that section, and a package ` +
            `it does not name ships with no licence text at all.`,
        });
      }
    }

    return findings;
  },
} satisfies Check;
