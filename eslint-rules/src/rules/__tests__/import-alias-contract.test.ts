// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Contract: every alias the fixer can emit is one the toolchain resolves.
 *
 * The rule rewrites a relative import into `<prefix>/<path>`, so `prefix`
 * becomes the first path segment. If the repo's tsconfig does not map that
 * segment, `eslint --fix` would turn working relative imports into
 * unresolvable ones — a fixer that breaks the build is worse than no fixer.
 *
 * This reads the real tsconfig files rather than restating the prefixes,
 * so the two cannot drift apart. It replaces the same contract that used
 * to pin a third-party plugin's `prefix` option, now that the prefixes
 * live in the rule instead of in configuration.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOTS } from "../no-relative-import";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Reads the alias prefixes a tsconfig declares, with the `/*` stripped.
 * @param tsconfigPath Absolute path to a tsconfig.json.
 * @returns The declared prefixes, e.g. `['@core', '@shared']`.
 * @throws {Error} If the file cannot be read or declares no paths.
 */
function tsconfigPrefixes(tsconfigPath: string): string[] {
  const raw = readFileSync(tsconfigPath, "utf-8").replace(/^\s*\/\/.*$/gm, "");
  const parsed = JSON.parse(raw) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  const paths = parsed.compilerOptions?.paths;
  if (!paths) throw new Error(`${tsconfigPath} declares no compilerOptions.paths`);
  return Object.keys(paths).map((key) => key.replace(/\/\*$/, ""));
}

/**
 * Reads the Node subpath import prefixes a package.json declares.
 * @param packageJsonPath Absolute path to a package.json.
 * @returns The declared prefixes, e.g. `['#rules']`.
 * @throws {Error} If the file cannot be read.
 */
function subpathPrefixes(packageJsonPath: string): string[] {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    imports?: Record<string, unknown>;
  };
  return Object.keys(parsed.imports ?? {}).map((key) => key.replace(/\/\*$/, ""));
}

describe("import alias contract (fixer output ↔ resolvable aliases)", () => {
  it.each(PACKAGE_ROOTS.map(([root, prefix]) => ({ root, prefix })))(
    "$root resolves $prefix",
    ({ root, prefix }) => {
      const packageDir = resolve(REPO_ROOT, root.replace(/\/src\/$/, ""));
      const declared = prefix.startsWith("#")
        ? subpathPrefixes(resolve(packageDir, "package.json"))
        : tsconfigPrefixes(resolve(packageDir, "tsconfig.json"));

      expect(
        declared,
        `the rule rewrites imports inside ${root} to "${prefix}/…", which ${packageDir} does not map`,
      ).toContain(prefix);
    },
  );

  it("covers every workspace package that has source", () => {
    // A package added without an entry here gets no fix and a vague message,
    // which is the quiet failure this list exists to prevent.
    const roots = PACKAGE_ROOTS.map(([root]) => root);
    expect(roots).toEqual([
      "packages/shared/src/",
      "packages/core/src/",
      "packages/domain/src/",
      "packages/server/src/",
      "packages/worker/src/",
      "packages/collab/src/",
      "packages/web/src/",
      "eslint-rules/src/",
      "repo-lint/src/",
    ]);
  });
});
