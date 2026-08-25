// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
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
 * The root manifest, which is where the import-graph linter's scope lives.
 *
 * Present in every case because its absence is a refusal, not a pass: a check
 * that skipped this half when the file was missing would report clean for
 * packages it never looked at.
 */
const ROOT = {
  "package.json": JSON.stringify({
    scripts: {
      "lint:dependency-cruiser":
        "depcruise --config x packages/*/src eslint-rules/src repo-lint/src",
    },
  }),
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
  return fakeContext({ ...WORKSPACE, ...ROOT, ...files });
}

describe("lint-coverage", () => {
  it("passes when every package lints", () => {
    const context = contextWith({
      "packages/core/package.json": manifest({ lint: "eslint ." }),
      "packages/web/package.json": manifest({ lint: "eslint ." }),
      "repo-lint/package.json": manifest({ lint: "eslint ." }),
    });
    expect(lintCoverage.run(context)).toEqual([]);
  });

  it("catches a package whose lint script was deleted", () => {
    // The failure this exists for: every rule goes dark for that package
    // and the whole suite still reports green.
    const context = contextWith({
      "packages/core/package.json": manifest({ lint: "eslint ." }),
      "packages/worker/package.json": manifest({ build: "tsup" }),
    });
    const findings = lintCoverage.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("packages/worker/package.json");
  });

  it("catches a lint script that points eslint at a subdirectory", () => {
    // Eight packages ran `eslint src/`, so every config file at the package
    // root was read by no rule at all — and the suite reported clean, because
    // "this package runs the linter" was true and "the linter sees the
    // package" was never asked. Narrowing it again should not be silent.
    const context = contextWith({
      "packages/core/package.json": manifest({ lint: "eslint src/" }),
    });
    const findings = lintCoverage.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/src\//);
  });

  it("accepts an invocation that covers the package and carries flags", () => {
    const context = contextWith({
      "packages/core/package.json": manifest({
        lint: "eslint . --max-warnings 0",
      }),
    });
    expect(lintCoverage.run(context)).toEqual([]);
  });

  it.each(["eslint ./", "eslint .//", "eslint './'"])(
    "accepts %j, which is the same directory spelt differently",
    (lint) => {
      // Comparing the word against the single character `.` made every other
      // spelling of the package root read as a narrowing, and the message it
      // then printed told the reader to point eslint at what it was already
      // pointed at. Path equality is the question; character equality was a
      // stand-in for it that only answered one spelling.
      expect(lintCoverage.run(contextWith({
        "packages/core/package.json": manifest({ lint }),
      }))).toEqual([]);
    },
  );

  it("is not satisfied by the empty word a stray space leaves behind", () => {
    // Splitting on whitespace turns a leading or trailing space into an empty
    // word, and an empty path resolves to the directory it is resolved
    // against — so the package would read as covered on the strength of a
    // space.
    const context = contextWith({
      "packages/core/package.json": manifest({ lint: " eslint src/ " }),
    });
    expect(lintCoverage.run(context)).toHaveLength(1);
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
    // The root manifest is a manifest and is not a workspace package; the
    // globs decide, so it is never asked for a lint script of its own.
    const context = contextWith({
      "packages/core/package.json": manifest({ lint: "eslint ." }),
    });
    expect(lintCoverage.run(context)).toEqual([]);
  });

  it("ignores a manifest nested deeper than a package root", () => {
    const context = contextWith({
      "packages/web/src/thing/package.json": manifest({}),
      "packages/core/package.json": manifest({ lint: "eslint ." }),
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
      "packages/core/package.json": manifest({ lint: "eslint ." }),
      "repo-lint/package.json": manifest({ lint: "eslint ." }),
    });
    const findings = lintCoverage.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/repo-lint\/src/);
  });

  it("reports a packages/ package the cruise arguments stopped covering", () => {
    // The hole a hard-coded skip left: anything under packages/ was taken to
    // be covered, because the argument list happened to open with
    // packages/*/src. Narrow that one argument and every other package under
    // it goes uncruised — with this check still reporting clean, which is the
    // exact shape of failure it exists to report, one level up.
    const context = contextWith({
      "package.json": JSON.stringify({
        scripts: {
          "lint:dependency-cruiser":
            "depcruise --config x packages/core/src repo-lint/src",
        },
      }),
      "packages/core/package.json": manifest({ lint: "eslint ." }),
      "packages/web/package.json": manifest({ lint: "eslint ." }),
      "repo-lint/package.json": manifest({ lint: "eslint ." }),
    });
    const findings = lintCoverage.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/packages\/web\/src/);
  });

  it("does not count a longer path that merely contains a package's own", () => {
    // A substring test answers "is this text in the script", not "is this
    // directory cruised". Any argument ending in the package's path satisfies
    // the first question while covering nothing of the second.
    const context = contextWith({
      "package.json": JSON.stringify({
        scripts: {
          "lint:dependency-cruiser":
            "depcruise --config x packages/*/src vendor/repo-lint/src",
        },
      }),
      "packages/core/package.json": manifest({ lint: "eslint ." }),
      "repo-lint/package.json": manifest({ lint: "eslint ." }),
    });
    const findings = lintCoverage.run(context);
    expect(findings.some((f) => f.message.includes("repo-lint/src"))).toBe(true);
  });

  it("refuses rather than reports clean when the root manifest is gone", () => {
    // Returning early there was the same fail-open one level down: the half
    // of the check that reads the cruise arguments simply did not run, and
    // every package came back uncruised-but-unreported.
    const context = fakeContext({
      ...WORKSPACE,
      "packages/core/package.json": manifest({ lint: "eslint ." }),
    });
    expect(() => lintCoverage.run(context)).toThrow(/package\.json is not there/);
  });

  it("refuses rather than reports clean when the cruise script is gone", () => {
    const context = contextWith({
      "package.json": JSON.stringify({ scripts: { test: "turbo test" } }),
      "packages/core/package.json": manifest({ lint: "eslint ." }),
    });
    expect(() => lintCoverage.run(context)).toThrow(/no `lint:dependency-cruiser`/);
  });

  it("accepts a cruise argument list that covers every package", () => {
    const context = contextWith({
      "package.json": JSON.stringify({
        scripts: {
          "lint:dependency-cruiser":
            "depcruise --config x packages/*/src repo-lint/src",
        },
      }),
      "packages/core/package.json": manifest({ lint: "eslint ." }),
      "repo-lint/package.json": manifest({ lint: "eslint ." }),
    });
    expect(lintCoverage.run(context)).toEqual([]);
  });

  it("finds a package the workspace declares later, with no change here", () => {
    // The point of reading pnpm-workspace.yaml: a top-level directory added
    // to the workspace is looked at without anyone remembering to widen a
    // pattern. A restated list would not look for it, and so would never
    // report it as unlinted — the exact failure this check exists to report.
    const context = fakeContext({
      ...ROOT,
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "tools/*"\n',
      "packages/core/package.json": manifest({ lint: "eslint ." }),
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

  // A hand-written parser stopped at the first line that was not an entry, so
  // an ordinary YAML comment or blank line inside the list silently truncated
  // it — and a package that is never looked for is never reported as unlinted,
  // which is the exact failure this check exists to report.
  it("reads the whole list past a comment inside it", () => {
    const context = fakeContext({
      ...ROOT,
      "pnpm-workspace.yaml":
        'packages:\n  - "packages/*"\n  # the two guard packages live at the root\n  - "repo-lint"\n',
      "packages/core/package.json": manifest({ lint: "eslint ." }),
      "repo-lint/package.json": manifest({ build: "tsc" }),
    });
    const findings = lintCoverage.run(context);
    expect(findings.some((f) => f.file === "repo-lint/package.json")).toBe(true);
  });

  it("reads the whole list past a blank line inside it", () => {
    const context = fakeContext({
      ...ROOT,
      "pnpm-workspace.yaml":
        'packages:\n  - "packages/*"\n\n  - "repo-lint"\n',
      "packages/core/package.json": manifest({ lint: "eslint ." }),
      "repo-lint/package.json": manifest({ build: "tsc" }),
    });
    const findings = lintCoverage.run(context);
    expect(findings.some((f) => f.file === "repo-lint/package.json")).toBe(true);
  });

  // pnpm's own documented example for this file is
  // `packages/**` plus `!**/test/**`. A hand-written glob-to-regex converter
  // turned `*` into one path segment and knew nothing of `!`, so the first
  // spelling looked only one directory deep and the second matched everything.
  // A package that is never looked for is never reported as unlinted, which
  // is the failure this check exists to report.
  it("finds a package nested deeper than one directory under the glob", () => {
    const context = fakeContext({
      ...ROOT,
      "pnpm-workspace.yaml": 'packages:\n  - "packages/**"\n',
      "packages/core/package.json": manifest({ lint: "eslint ." }),
      "packages/tools/codegen/package.json": manifest({ build: "tsc" }),
    });
    const findings = lintCoverage.run(context);
    expect(
      findings.some((f) => f.file === "packages/tools/codegen/package.json"),
    ).toBe(true);
  });

  it("honours an exclusion entry rather than reading it as a pattern", () => {
    // Both halves asserted together, because either alone passes for the
    // wrong reason: a matcher that matches nothing satisfies the exclusion,
    // and a matcher that ignores `!` satisfies the inclusion.
    const context = fakeContext({
      ...ROOT,
      "pnpm-workspace.yaml":
        'packages:\n  - "packages/**"\n  - "!**/fixtures/**"\n',
      "packages/core/package.json": manifest({ lint: "eslint ." }),
      "packages/tools/codegen/package.json": manifest({ build: "tsc" }),
      "packages/core/fixtures/sample/package.json": manifest({}),
    });
    const files = lintCoverage.run(context).map((f) => f.file);
    expect(files).toContain("packages/tools/codegen/package.json");
    expect(files).not.toContain("packages/core/fixtures/sample/package.json");
  });

  it("accepts the inline-array spelling of the same list", () => {
    const context = fakeContext({
      ...ROOT,
      "pnpm-workspace.yaml": 'packages: ["packages/*", "repo-lint"]\n',
      "packages/core/package.json": manifest({ lint: "eslint ." }),
      "repo-lint/package.json": manifest({ build: "tsc" }),
    });
    const findings = lintCoverage.run(context);
    expect(findings.some((f) => f.file === "repo-lint/package.json")).toBe(true);
  });

  it("accepts an entry carrying a trailing comment", () => {
    const context = fakeContext({
      ...ROOT,
      "pnpm-workspace.yaml":
        'packages:\n  - "packages/*"\n  - "repo-lint" # the checks themselves\n',
      "packages/core/package.json": manifest({ lint: "eslint ." }),
      "repo-lint/package.json": manifest({ build: "tsc" }),
    });
    const findings = lintCoverage.run(context);
    expect(findings.some((f) => f.file === "repo-lint/package.json")).toBe(true);
  });
});
