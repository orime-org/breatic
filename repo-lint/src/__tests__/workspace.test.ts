// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { declaredBy, workspaceGlobs, workspacePackages } from "#repo-lint/workspace";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

describe("declaredBy", () => {
  it("accepts a manifest one directory under a single-star glob", () => {
    expect(declaredBy(["packages/*"])("packages/core/package.json")).toBe(true);
  });

  it("rejects a manifest nested deeper than a single-star glob reaches", () => {
    expect(declaredBy(["packages/*"])("packages/core/src/x/package.json")).toBe(
      false,
    );
  });

  it("accepts a manifest at any depth under a double-star glob", () => {
    const declared = declaredBy(["packages/**"]);
    expect(declared("packages/core/package.json")).toBe(true);
    expect(declared("packages/tools/codegen/package.json")).toBe(true);
  });

  it("accepts a glob naming one directory outright", () => {
    expect(declaredBy(["repo-lint"])("repo-lint/package.json")).toBe(true);
  });

  it("rejects a file that is not a manifest", () => {
    expect(declaredBy(["packages/*"])("packages/core/tsconfig.json")).toBe(false);
  });

  it("honours an exclusion entry rather than reading it as a pattern", () => {
    const declared = declaredBy(["packages/**", "!**/fixtures/**"]);
    expect(declared("packages/core/package.json")).toBe(true);
    expect(declared("packages/core/fixtures/sample/package.json")).toBe(false);
  });

  it("excludes the very directory an exclusion names, not only what is under it", () => {
    // Measured against pnpm itself: a workspace declaring `packages/**` and
    // `!**/fixtures/**`, holding a package at packages/core/fixtures and
    // another at packages/core/fixtures/sample, reports exactly one package
    // — neither of those two. Matching the exclusion against the directory
    // left the first of them declared here, so a package pnpm does not
    // install would have been demanded to carry a lint script. Matching the
    // manifest path, which is what pnpm globs over, answers both the same.
    expect(
      declaredBy(["packages/**", "!**/fixtures/**"])(
        "packages/core/fixtures/package.json",
      ),
    ).toBe(false);
  });

  it("reads a glob written with a trailing slash as the same glob", () => {
    expect(declaredBy(["packages/*/"])("packages/core/package.json")).toBe(true);
  });
});

describe("workspaceGlobs", () => {
  it("reads the entries the workspace declares, in order", () => {
    const context = fakeContext({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "repo-lint"\n',
    });
    expect(workspaceGlobs(context)).toEqual(["packages/*", "repo-lint"]);
  });

  it("refuses rather than reports nothing when the file is gone", () => {
    expect(() => workspaceGlobs(fakeContext({ "a.md": "x" }))).toThrow(
      /pnpm-workspace\.yaml/,
    );
  });

  it("refuses rather than reports nothing when the list is empty", () => {
    expect(() =>
      workspaceGlobs(fakeContext({ "pnpm-workspace.yaml": "packages: []\n" })),
    ).toThrow(/declares no packages/);
  });
});

describe("workspacePackages", () => {
  it("names the directory of each declared package", () => {
    const context = fakeContext({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "repo-lint"\n',
      "packages/core/package.json": "{}",
      "repo-lint/package.json": "{}",
      "packages/core/src/index.ts": "",
    });
    expect(workspacePackages(context)).toEqual(["packages/core", "repo-lint"]);
  });
});
