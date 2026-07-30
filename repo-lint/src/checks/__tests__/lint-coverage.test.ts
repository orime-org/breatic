// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { lintCoverage } from "#repo-lint/checks/lint-coverage";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/**
 * Builds a manifest with the given scripts.
 * @param scripts The package's scripts.
 * @returns The manifest as text.
 */
function manifest(scripts: Record<string, string>): string {
  return JSON.stringify({ name: "@breatic/x", scripts });
}

describe("lint-coverage", () => {
  it("passes when every package lints", () => {
    const context = fakeContext({
      "packages/core/package.json": manifest({ lint: "eslint src/" }),
      "packages/web/package.json": manifest({ lint: "eslint ." }),
      "repo-lint/package.json": manifest({ lint: "eslint src/" }),
    });
    expect(lintCoverage.run(context)).toEqual([]);
  });

  it("catches a package whose lint script was deleted", () => {
    // The failure this exists for: every rule goes dark for that package
    // and the whole suite still reports green.
    const context = fakeContext({
      "packages/core/package.json": manifest({ lint: "eslint src/" }),
      "packages/worker/package.json": manifest({ build: "tsup" }),
    });
    const findings = lintCoverage.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("packages/worker/package.json");
  });

  it("catches a lint script that does not run eslint", () => {
    const context = fakeContext({
      "packages/core/package.json": manifest({ lint: "echo skipped" }),
    });
    expect(lintCoverage.run(context)).toHaveLength(1);
  });

  it("covers the two rule packages, not only packages/", () => {
    // They hold the rules themselves; a rule file that breaks the rules is
    // the least defensible place to stop looking.
    for (const directory of ["eslint-rules", "repo-lint"]) {
      const context = fakeContext({
        [`${directory}/package.json`]: manifest({ build: "tsc" }),
      });
      expect(lintCoverage.run(context), directory).toHaveLength(1);
    }
  });

  it("ignores manifests outside the workspace", () => {
    const context = fakeContext({
      "package.json": manifest({ test: "turbo test" }),
      "packages/core/package.json": manifest({ lint: "eslint src/" }),
    });
    expect(lintCoverage.run(context)).toEqual([]);
  });

  it("ignores a manifest nested deeper than a package root", () => {
    const context = fakeContext({
      "packages/web/src/thing/package.json": manifest({}),
      "packages/core/package.json": manifest({ lint: "eslint src/" }),
    });
    expect(lintCoverage.run(context)).toEqual([]);
  });

  it("fails rather than reports clean when it finds no manifests", () => {
    expect(() => lintCoverage.run(fakeContext({ "a.md": "x" }))).toThrow(
      /matched none/,
    );
  });

  it("reports a package the dependency graph is never cruised for", () => {
    // The import-graph rules are a second linter with a second scope, and it
    // is given directories by hand. Two packages added to the workspace sat
    // outside its arguments and had no import rule applied to them at all —
    // which is the same shape as a package with no lint script, one tool
    // over.
    const context = fakeContext({
      "package.json": JSON.stringify({
        scripts: {
          "lint:dependency-cruiser": "depcruise --config x packages/*/src",
        },
      }),
      "packages/core/package.json": manifest({ lint: "eslint src/" }),
      "repo-lint/package.json": manifest({ lint: "eslint src/" }),
    });
    const findings = lintCoverage.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/repo-lint\/src/);
  });

  it("accepts a cruise argument list that covers every package", () => {
    const context = fakeContext({
      "package.json": JSON.stringify({
        scripts: {
          "lint:dependency-cruiser":
            "depcruise --config x packages/*/src repo-lint/src",
        },
      }),
      "packages/core/package.json": manifest({ lint: "eslint src/" }),
      "repo-lint/package.json": manifest({ lint: "eslint src/" }),
    });
    expect(lintCoverage.run(context)).toEqual([]);
  });
});
