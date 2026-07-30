// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { TARGETS, docLinks } from "#repo-lint/checks/doc-links";
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
  "packages/shared/src/index.ts": "",
  "packages/shared/tsconfig.json": "{}",
};

describe("doc-links", () => {
  it("fails rather than reports clean when the options file is missing", () => {
    // Without it the resolver runs on defaults, which validate nothing —
    // the check would pass every run while checking nothing at all.
    const context = fakeContext({
      "packages/shared/src/index.ts": "",
      "packages/shared/tsconfig.json": "{}",
    });
    expect(() => docLinks.run(context)).toThrow(/typedoc\.doclinks\.json/);
  });

  it("fails rather than reports clean when a package's entry is gone", () => {
    const context = fakeContext({ "typedoc.doclinks.json": "{}" });
    expect(() => docLinks.run(context)).toThrow(/does not exist/);
  });

  it("fails rather than reports clean when a package's tsconfig is gone", () => {
    const context = fakeContext({
      "typedoc.doclinks.json": "{}",
      "packages/shared/src/index.ts": "",
    });
    expect(() => docLinks.run(context)).toThrow(
      /packages\/shared\/tsconfig\.json/,
    );
  });

  it("fails rather than reports clean when the resolver cannot run", () => {
    // A resolver that never started has checked nothing, and the check
    // exists because nothing else checks prose — reporting clean there
    // would put prose back to unverified while looking verified. The
    // temporary directory has no resolver installed, so this is the real
    // path rather than a stub of it.
    const context = fakeContext(REQUIRED, tmpdir());
    expect(() => docLinks.run(context)).toThrow(/could not run for shared/);
  });

  it("names every package, so none goes unscanned", () => {
    // The list is written by hand, which is the one way a package can go
    // unscanned without anything failing. Asserting the whole list means
    // adding a package to the repository and not to this list shows up
    // here rather than as a package nobody checks.
    expect(TARGETS.map((target) => target.name).sort()).toEqual([
      "collab",
      "core",
      "domain",
      "server",
      "shared",
      "web",
      "worker",
    ]);
  });

  it("follows exports inward for libraries and file by file for web", () => {
    // Measured, not assumed: web's entry renders a React tree and exports
    // nothing, so following its exports reaches almost no files. A link
    // planted deep in a canvas component went unseen under `resolve`.
    for (const target of TARGETS) {
      expect(target.strategy, target.name).toBe(
        target.name === "web" ? "expand" : "resolve",
      );
    }
  });
});
