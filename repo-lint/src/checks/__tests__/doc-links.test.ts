// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { docLinks, scanTargets } from "#repo-lint/checks/doc-links";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/**
 * The files the check requires before it will run the resolver.
 *
 * Only the preconditions are exercised here. What the resolver reports is
 * covered by the tests for `complaintsFrom`, against recorded output —
 * running the real resolver seven times per assertion would test the tool
 * rather than this check.
 */
const REQUIRED = {
  "typedoc.doclinks.json": "{}",
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
  "packages/shared/package.json": "{}",
  "packages/shared/src/index.ts": "",
  "packages/shared/tsconfig.json": "{}",
};

describe("doc-links", () => {
  it("fails rather than reports clean when the options file is missing", () => {
    // Without it the resolver runs on defaults, which validate nothing —
    // the check would pass every run while checking nothing at all.
    const { "typedoc.doclinks.json": _options, ...rest } = REQUIRED;
    expect(() => docLinks.run(fakeContext(rest))).toThrow(
      /typedoc\.doclinks\.json/,
    );
  });

  it("fails rather than reports clean when the workspace file is gone", () => {
    // Which packages exist is read from that file; without it the check
    // cannot know what it is meant to scan, and guessing would mean
    // reporting clean for packages it never looked for.
    const { "pnpm-workspace.yaml": _workspace, ...rest } = REQUIRED;
    expect(() => docLinks.run(fakeContext(rest))).toThrow(
      /pnpm-workspace\.yaml/,
    );
  });

  it("fails rather than reports clean when a package's tsconfig is gone", () => {
    const { "packages/shared/tsconfig.json": _tsconfig, ...rest } = REQUIRED;
    expect(() => docLinks.run(fakeContext(rest))).toThrow(/no tsconfig\.json/);
  });

  it("fails rather than reports clean when the resolver cannot run", () => {
    // A resolver that never started has checked nothing, and the check
    // exists because nothing else checks prose — reporting clean there
    // would put prose back to unverified while looking verified. The
    // temporary directory has no resolver installed, so this is the real
    // path rather than a stub of it.
    const context = fakeContext(REQUIRED, tmpdir());
    expect(() => docLinks.run(context)).toThrow(/could not run for packages\/shared/);
  });

  it("finds a package the workspace gains, with no change here", () => {
    // The list used to be written by hand, and the test that guarded it
    // compared that list against a second hand-written copy — so adding a
    // package to the repository and to neither list left both green while
    // the package went unscanned. Derived from the tree, an eighth package
    // arrives on its own.
    const targets = scanTargets(
      ["packages/core", "packages/notify"],
      [
        "packages/core/tsconfig.json",
        "packages/core/src/index.ts",
        "packages/notify/tsconfig.json",
        "packages/notify/src/index.ts",
      ],
    );
    expect(targets.map((target) => target.directory)).toEqual([
      "packages/core",
      "packages/notify",
    ]);
  });

  it("follows exports inward for a library and file by file for an app", () => {
    // Measured, not assumed: web's entry renders a React tree and exports
    // nothing, so following its exports reaches almost no files. A link
    // planted deep in a canvas component went unseen under `resolve`. What
    // separates the two is whether the package publishes a barrel, so that
    // is what decides it.
    const targets = scanTargets(
      ["packages/core", "packages/web"],
      [
        "packages/core/tsconfig.json",
        "packages/core/src/index.ts",
        "packages/web/tsconfig.json",
        "packages/web/src/main.tsx",
      ],
    );
    expect(targets[0]).toEqual({
      directory: "packages/core",
      entry: "packages/core/src/index.ts",
      strategy: "resolve",
    });
    expect(targets[1]).toEqual({
      directory: "packages/web",
      entry: "packages/web/src",
      strategy: "expand",
    });
  });

  it("passes over a workspace entry that holds no TypeScript", () => {
    expect(
      scanTargets(["tools/fixtures"], ["tools/fixtures/package.json"]),
    ).toEqual([]);
  });

  it("refuses a package that holds TypeScript with no tsconfig", () => {
    // Filtering it out instead would stop the package being scanned with
    // nothing failing, which is the shape this whole suite exists to remove.
    expect(() =>
      scanTargets(["packages/notify"], ["packages/notify/src/index.ts"]),
    ).toThrow(/no tsconfig\.json/);
  });
});
