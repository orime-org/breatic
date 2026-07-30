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

/** The workspace definition the check reads to know where packages live. */
const WORKSPACE = {
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "eslint-rules"\n  - "repo-lint"\n',
};

/**
 * Builds a context holding the workspace definition plus the given files.
 *
 * The check reads which packages the workspace declares rather than
 * restating it, so every case has to supply that file.
 * @param files Repo-relative path to contents.
 * @returns A context the check will run against.
 */
function contextWith(files: Record<string, string>) {
  return fakeContext({ ...WORKSPACE, ...files });
}

describe("lint-coverage", () => {
  it("passes when every package lints", () => {
    const context = contextWith({
      "packages/core/package.json": manifest({ lint: "eslint src/" }),
      "packages/web/package.json": manifest({ lint: "eslint ." }),
      "repo-lint/package.json": manifest({ lint: "eslint src/" }),
    });
    expect(lintCoverage.run(context)).toEqual([]);
  });

  it("catches a package whose lint script was deleted", () => {
    // The failure this exists for: every rule goes dark for that package
    // and the whole suite still reports green.
    const context = contextWith({
      "packages/core/package.json": manifest({ lint: "eslint src/" }),
      "packages/worker/package.json": manifest({ build: "tsup" }),
    });
    const findings = lintCoverage.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("packages/worker/package.json");
  });

  it("catches a lint script that does not run eslint", () => {
    const context = contextWith({
      "packages/core/package.json": manifest({ lint: "echo skipped" }),
    });
    expect(lintCoverage.run(context)).toHaveLength(1);
  });

  it("covers the two rule packages, not only packages/", () => {
    // They hold the rules themselves; a rule file that breaks the rules is
    // the least defensible place to stop looking.
    for (const directory of ["eslint-rules", "repo-lint"]) {
      const context = contextWith({
        [`${directory}/package.json`]: manifest({ build: "tsc" }),
      });
      expect(lintCoverage.run(context), directory).toHaveLength(1);
    }
  });

  it("ignores manifests outside the workspace", () => {
    const context = contextWith({
      "package.json": manifest({ test: "turbo test" }),
      "packages/core/package.json": manifest({ lint: "eslint src/" }),
    });
    expect(lintCoverage.run(context)).toEqual([]);
  });

  it("ignores a manifest nested deeper than a package root", () => {
    const context = contextWith({
      "packages/web/src/thing/package.json": manifest({}),
      "packages/core/package.json": manifest({ lint: "eslint src/" }),
    });
    expect(lintCoverage.run(context)).toEqual([]);
  });

  it("fails rather than reports clean when it finds no manifests", () => {
    expect(() => lintCoverage.run(contextWith({ "a.md": "x" }))).toThrow(
      /matched none/,
    );
  });

  it("reports a package the dependency graph is never cruised for", () => {
    // The import-graph rules are a second linter with a second scope, and it
    // is given directories by hand. Two packages added to the workspace sat
    // outside its arguments and had no import rule applied to them at all —
    // which is the same shape as a package with no lint script, one tool
    // over.
    const context = contextWith({
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
    const context = contextWith({
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

  it("finds a package the workspace declares later, with no change here", () => {
    // The point of reading pnpm-workspace.yaml: a top-level directory added
    // to the workspace is looked at without anyone remembering to widen a
    // pattern. A restated list would not look for it, and so would never
    // report it as unlinted — the exact failure this check exists to report.
    const context = fakeContext({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "tools/*"\n',
      "packages/core/package.json": manifest({ lint: "eslint src/" }),
      "tools/codegen/package.json": manifest({ build: "tsc" }),
    });
    const findings = lintCoverage.run(context);
    expect(findings.some((f) => f.file === "tools/codegen/package.json")).toBe(
      true,
    );
  });

  it("refuses rather than reports clean when the workspace file is gone", () => {
    expect(() =>
      lintCoverage.run(
        fakeContext({ "packages/core/package.json": manifest({ lint: "eslint" }) }),
      ),
    ).toThrow(/pnpm-workspace\.yaml/);
  });
});
