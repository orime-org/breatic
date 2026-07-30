// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { noUnresolvedAliasInDist } from "#repo-lint/checks/no-unresolved-alias-in-dist";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/** The aliases the real tsconfigs declare, which the check derives from. */
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    paths: {
      "@shared/*": ["../shared/src/*"],
      "@core/*": ["../core/src/*"],
      "@domain/*": ["../domain/src/*"],
      "@server/*": ["./src/*"],
      "@worker/*": ["../worker/src/*"],
      "@collab/*": ["../collab/src/*"],
      "@web/*": ["./src/*"],
      "@locales/*": ["../../locales/*"],
    },
  },
});

/**
 * Builds a context holding one package with the given built output.
 * @param bundle Contents of that package's built module.
 * @param name Package directory name.
 * @returns A context over that package.
 */
function built(bundle: string, name = "shared") {
  return fakeContext({
    [`packages/${name}/package.json`]: "{}",
    [`packages/${name}/tsconfig.json`]: TSCONFIG,
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
      "packages/shared/tsconfig.json": TSCONFIG,
      "packages/shared/dist/index.js": "const a = 1;\n",
      "packages/shared/dist/index.js.map": '{"sources":["@core/x.ts"]}',
    });
    expect(noUnresolvedAliasInDist.run(context)).toEqual([]);
  });

  it("catches an alias left in a type declaration", () => {
    // An alias in a `.d.ts` fails every consumer's typecheck rather than
    // their runtime, which makes it later and no less broken. The guard
    // this replaces looked only at modules.
    const context = fakeContext({
      "packages/shared/package.json": "{}",
      "packages/shared/tsconfig.json": TSCONFIG,
      "packages/shared/dist/index.js": "const a = 1;\n",
      "packages/shared/dist/index.d.ts": 'import type { A } from "@core/a.js";\n',
    });
    expect(noUnresolvedAliasInDist.run(context)).toHaveLength(1);
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
    const context = fakeContext({
      "packages/shared/package.json": "{}",
      "packages/shared/tsconfig.json": TSCONFIG,
    });
    expect(() => noUnresolvedAliasInDist.run(context)).toThrow(/does not exist/);
  });

  it("fails rather than reports clean when there are no packages", () => {
    expect(() => noUnresolvedAliasInDist.run(fakeContext({ "a.md": "x" }))).toThrow(
      /matched none/,
    );
  });

  it("derives the alias list rather than carrying a copy of it", () => {
    // The hand-kept list is how the shell guard went blind: it named seven
    // prefixes while the tsconfigs declared eight. An alias declared but
    // absent from any hardcoded list must still be caught.
    const context = fakeContext({
      "packages/shared/package.json": "{}",
      "packages/shared/tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@invented/*": ["../invented/src/*"] } },
      }),
      "packages/shared/dist/index.js": 'import x from "@invented/thing.js";\n',
    });
    expect(noUnresolvedAliasInDist.run(context)).toHaveLength(1);
  });

  it("fails rather than reports clean when no tsconfig declares an alias", () => {
    const context = fakeContext({
      "packages/shared/package.json": "{}",
      "packages/shared/tsconfig.json": "{}",
      "packages/shared/dist/index.js": "const a = 1;\n",
    });
    expect(() => noUnresolvedAliasInDist.run(context)).toThrow(/match nothing/);
  });

  it("ignores an alias that appears only inside a comment", () => {
    // A doc block may show the package's own entry point in an @example,
    // and nothing resolves an import that exists only in prose. Live
    // regression: domain documents its tool registry that way, and this
    // reported it as an alias that survived the build.
    const context = fakeContext({
      "packages/shared/package.json": "{}",
      "packages/shared/tsconfig.json": TSCONFIG,
      "packages/shared/dist/index.js":
        '/**\n * @example\n * import { a } from "@core/thing.js";\n */\nconst a = 1;\n',
    });
    expect(noUnresolvedAliasInDist.run(context)).toEqual([]);
  });

  it("still catches a real import on the line after a comment", () => {
    const context = fakeContext({
      "packages/shared/package.json": "{}",
      "packages/shared/tsconfig.json": TSCONFIG,
      "packages/shared/dist/index.js":
        '// see "@core/x.js"\nimport { a } from "@core/real.js";\n',
    });
    expect(noUnresolvedAliasInDist.run(context)).toHaveLength(1);
  });
});
