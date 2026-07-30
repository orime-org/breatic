// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { noUnresolvedAliasInDist } from "#repo-lint/checks/no-unresolved-alias-in-dist";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/**
 * Builds a context holding one package with the given built output.
 * @param bundle Contents of that package's built module.
 * @param name Package directory name.
 * @returns A context over that package.
 */
function built(bundle: string, name = "shared") {
  return fakeContext({
    [`packages/${name}/package.json`]: "{}",
    [`packages/${name}/dist/index.js`]: bundle,
  });
}

describe("no-unresolved-alias-in-dist", () => {
  it("passes output with no internal alias", () => {
    expect(
      noUnresolvedAliasInDist.run(built('import { a } from "zod";\n')),
    ).toEqual([]);
  });

  it("catches every alias prefix", () => {
    for (const alias of [
      "shared",
      "core",
      "domain",
      "collab",
      "worker",
      "server",
      "web",
    ]) {
      const findings = noUnresolvedAliasInDist.run(
        built(`import { a } from "@${alias}/x.js";\n`),
      );
      expect(findings, alias).toHaveLength(1);
    }
  });

  it("catches @locales, which the shell guard's list omitted", () => {
    // Declared in the web package's tsconfig and every bit as unresolvable
    // at runtime as the seven the guard did list.
    expect(
      noUnresolvedAliasInDist.run(built('import x from "@locales/en.json";\n')),
    ).toHaveLength(1);
  });

  it("catches a re-export and a dynamic import", () => {
    expect(
      noUnresolvedAliasInDist.run(built("export * from '@web/x.js';\n")),
    ).toHaveLength(1);
    expect(
      noUnresolvedAliasInDist.run(
        built('const m = await import("@collab/y.js");\n'),
      ),
    ).toHaveLength(1);
  });

  it("catches require, which the shell guard's alternation omitted", () => {
    // Latent rather than live — everything builds ESM today — but a build
    // format is one config line away from changing.
    expect(
      noUnresolvedAliasInDist.run(built('const m = require("@domain/z.js");\n')),
    ).toHaveLength(1);
  });

  it("leaves the real workspace package name alone", () => {
    // `@breatic/shared` is a package npm can resolve; the alias is not.
    expect(
      noUnresolvedAliasInDist.run(built('import x from "@breatic/shared";\n')),
    ).toEqual([]);
  });

  it("requires the slash — a bare @shared is not an alias import", () => {
    expect(
      noUnresolvedAliasInDist.run(built('import x from "@shared";\n')),
    ).toEqual([]);
  });

  it("skips source maps, which carry the pre-bundle source verbatim", () => {
    const context = fakeContext({
      "packages/shared/package.json": "{}",
      "packages/shared/dist/index.js": "const a = 1;\n",
      "packages/shared/dist/index.js.map": '{"sources":["@core/x.ts"]}',
    });
    expect(noUnresolvedAliasInDist.run(context)).toEqual([]);
  });

  it("names the file and line", () => {
    const findings = noUnresolvedAliasInDist.run(
      built('const a = 1;\nimport { b } from "@core/b.js";\n'),
    );
    expect(findings[0]?.file).toBe("packages/shared/dist/index.js");
    expect(findings[0]?.line).toBe(2);
  });

  it("fails rather than reports clean when a package is not built", () => {
    // The failure mode this check exists to prevent, one level up: an
    // unbuilt tree must not read as a clean one.
    const context = fakeContext({ "packages/shared/package.json": "{}" });
    expect(() => noUnresolvedAliasInDist.run(context)).toThrow(/does not exist/);
  });

  it("fails rather than reports clean when there are no packages", () => {
    expect(() => noUnresolvedAliasInDist.run(fakeContext({ "a.md": "x" }))).toThrow(
      /matched none/,
    );
  });
});
