// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { sharedDepsInCatalog } from "#repo-lint/checks/shared-deps-in-catalog";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/** An empty workspace + lockfile, so a case can supply only what it is about. */
const BARE = {
  "pnpm-workspace.yaml": "catalog:\n",
  "pnpm-lock.yaml": "importers:\n",
};

describe("shared-deps-in-catalog", () => {
  it("passes when a shared dependency reads catalog: everywhere", () => {
    const context = fakeContext({
      ...BARE,
      "packages/a/package.json": '{"dependencies":{"zod":"catalog:"}}',
      "packages/b/package.json": '{"dependencies":{"zod":"catalog:"}}',
    });
    expect(sharedDepsInCatalog.run(context)).toEqual([]);
  });

  it("leaves a dependency only one package declares alone", () => {
    // Nothing for it to disagree with, and routing every private choice through
    // a workspace-wide catalog buys nothing.
    const context = fakeContext({
      ...BARE,
      "packages/a/package.json": '{"dependencies":{"zod":"^3.0.0"}}',
      "packages/b/package.json": '{"dependencies":{"other":"^1.0.0"}}',
    });
    expect(sharedDepsInCatalog.run(context)).toEqual([]);
  });

  it("reports a shared dependency that pins its own version, naming the siblings", () => {
    const context = fakeContext({
      ...BARE,
      "packages/a/package.json": '{"dependencies":{"zod":"^3.0.0"}}',
      "packages/b/package.json": '{"dependencies":{"zod":"^4.0.0"}}',
    });
    const findings = sharedDepsInCatalog.run(context);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.file).toBe("packages/a/package.json");
    expect(findings[0]?.message).toContain("packages/b/package.json (^4.0.0)");
  });

  it("reports the odd one out even when the others already use the catalog", () => {
    const context = fakeContext({
      ...BARE,
      "packages/a/package.json": '{"dependencies":{"zod":"catalog:"}}',
      "packages/b/package.json": '{"dependencies":{"zod":"catalog:"}}',
      "packages/c/package.json": '{"devDependencies":{"zod":"^3.0.0"}}',
    });
    const findings = sharedDepsInCatalog.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("packages/c/package.json");
  });

  it("ignores workspace: ranges — they resolve to the checkout, with no version to drift", () => {
    const context = fakeContext({
      ...BARE,
      "packages/a/package.json": '{"dependencies":{"@breatic/core":"workspace:*"}}',
      "packages/b/package.json": '{"dependencies":{"@breatic/core":"workspace:*"}}',
    });
    expect(sharedDepsInCatalog.run(context)).toEqual([]);
  });

  it("catches a catalogued package our own importers resolve two ways", () => {
    // The real case: eslint-rules pulled @typescript-eslint/rule-tester without
    // declaring eslint, so pnpm satisfied that peer with the newest release and
    // the lockfile carried both majors while every manifest read "catalog:".
    const context = fakeContext({
      ...BARE,
      "pnpm-workspace.yaml": 'catalog:\n  "eslint": ^9.39.2\n',
      "pnpm-lock.yaml": [
        "importers:",
        "  .:",
        "    devDependencies:",
        "      eslint:",
        "        specifier: 'catalog:'",
        "        version: 9.39.5",
        "  eslint-rules:",
        "    devDependencies:",
        "      '@typescript-eslint/rule-tester':",
        "        specifier: 8.58.0",
        "        version: 8.58.0(eslint@10.1.0)",
        "      eslint:",
        "        specifier: 'catalog:'",
        "        version: 10.1.0",
        "",
      ].join("\n"),
      "packages/a/package.json": '{"devDependencies":{"eslint":"catalog:"}}',
    });
    const findings = sharedDepsInCatalog.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("pnpm-lock.yaml");
    expect(findings[0]?.message).toContain("10.1.0 and 9.39.5");
  });

  it("does not flag a version only a third-party package pulls in", () => {
    // @eslint/eslintrc depends on globals@14 while we use 16. That lives outside
    // the importers section, is not ours to unify, and a finding about it would
    // be one nobody can act on.
    const context = fakeContext({
      ...BARE,
      "pnpm-workspace.yaml": 'catalog:\n  "globals": ^16.5.0\n',
      "pnpm-lock.yaml": [
        "importers:",
        "  .:",
        "    devDependencies:",
        "      globals:",
        "        specifier: 'catalog:'",
        "        version: 16.5.0",
        "packages:",
        "  globals@14.0.0:",
        "    resolution: {integrity: sha512-x}",
        "",
      ].join("\n"),
      "packages/a/package.json": '{"devDependencies":{"globals":"catalog:"}}',
    });
    expect(sharedDepsInCatalog.run(context)).toEqual([]);
  });
});
