// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { dependenciesDeclareWhatShips } from "#repo-lint/checks/dependencies-declare-what-ships";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/**
 * A manifest with the two sections this check reads.
 * @param dependencies - Names to declare as dependencies.
 * @param devDependencies - Names to declare as devDependencies.
 * @returns The manifest as JSON text.
 */
function manifest(
  dependencies: string[],
  devDependencies: string[],
): string {
  return JSON.stringify({
    name: "@breatic/web",
    dependencies: Object.fromEntries(dependencies.map((n) => [n, "^1.0.0"])),
    devDependencies: Object.fromEntries(
      devDependencies.map((n) => [n, "^1.0.0"]),
    ),
  });
}

describe("dependencies-declare-what-ships", () => {
  it("reports a package the source imports from devDependencies", () => {
    const findings = dependenciesDeclareWhatShips.run(
      fakeContext({
        "packages/web/package.json": manifest([], ["y-protocols"]),
        "packages/web/src/cursors.tsx": "import { Awareness } from 'y-protocols/awareness';",
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("y-protocols");
    expect(findings[0]?.file).toBe("packages/web/package.json");
  });

  it("reports a stylesheet importing from devDependencies, which no JavaScript linter sees", () => {
    const findings = dependenciesDeclareWhatShips.run(
      fakeContext({
        "packages/web/package.json": manifest([], ["tw-animate-css"]),
        "packages/web/src/index.css": "@import 'tw-animate-css';",
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("tw-animate-css");
  });

  it("says nothing when the import is already a dependency", () => {
    expect(
      dependenciesDeclareWhatShips.run(
        fakeContext({
          "packages/web/package.json": manifest(["react"], []),
          "packages/web/src/app.tsx": "import React from 'react';",
        }),
      ),
    ).toEqual([]);
  });

  it("leaves test files alone, where a devDependency is what belongs", () => {
    expect(
      dependenciesDeclareWhatShips.run(
        fakeContext({
          "packages/web/package.json": manifest(["react"], ["vitest", "axe-core"]),
          "packages/web/src/app.tsx": "import React from 'react';",
          "packages/web/src/__tests__/app.test.tsx": "import { it } from 'vitest';",
          "packages/web/src/test-utils/a11y.ts": "import axe from 'axe-core';",
        }),
      ),
    ).toEqual([]);
  });

  it("keeps the scope of a scoped name, rather than cutting at the first slash", () => {
    const findings = dependenciesDeclareWhatShips.run(
      fakeContext({
        "packages/web/package.json": manifest([], ["@tanstack/react-query"]),
        "packages/web/src/data.ts":
          "import { useQuery } from '@tanstack/react-query';",
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("@tanstack/react-query");
  });

  it("ignores relative paths, aliases and node builtins", () => {
    expect(
      dependenciesDeclareWhatShips.run(
        fakeContext({
          "packages/web/package.json": manifest([], ["vitest"]),
          "packages/web/src/app.ts":
            "import a from './a';\nimport b from '@web/b';\nimport c from 'node:fs';\nimport d from '@breatic/shared';",
        }),
      ),
    ).toEqual([]);
  });

  it("leaves the guard packages alone, which ship nothing and are development tools throughout", () => {
    expect(
      dependenciesDeclareWhatShips.run(
        fakeContext({
          "packages/web/package.json": manifest(["react"], []),
          "packages/web/src/app.tsx": "import React from 'react';",
          "repo-lint/package.json": manifest([], ["yaml"]),
          "repo-lint/src/main.ts": "import { parse } from 'yaml';",
        }),
      ),
    ).toEqual([]);
  });
});
