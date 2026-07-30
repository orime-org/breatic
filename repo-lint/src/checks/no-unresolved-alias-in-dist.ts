// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { stripComments } from "#repo-lint/strip-comments";

/**
 * Reads the alias prefixes the packages declare for themselves.
 *
 * Derived rather than listed, because a hand-kept list is how the guard
 * this replaces went blind: it named seven prefixes while the tsconfigs
 * declared eight, so a leak through `@locales` was invisible. Reading the
 * declarations means a new alias is covered the day it is added.
 *
 * A real package name is never in here — `@breatic/shared` resolves at
 * runtime and is not an alias — because tsconfig `paths` only ever carries
 * the compile-time ones. Asserted below rather than assumed.
 * @param context Access to the repository's files.
 * @returns The prefixes, without the leading `@` or the trailing `/*`.
 * @throws {Error} If no tsconfig declares any alias, which would leave this
 *   check matching nothing at all.
 */
function internalAliases(context: CheckContext): string[] {
  const configs = context.files(
    (path) => /^packages\/[^/]+\/tsconfig\.json$/.test(path),
    "package tsconfigs",
  );
  const prefixes = new Set<string>();
  for (const config of configs) {
    // tsconfig permits comments, which JSON.parse does not.
    const parsed = JSON.parse(
      context.read(config).replace(/^\s*\/\/.*$/gm, ""),
    ) as { compilerOptions?: { paths?: Record<string, unknown> } };
    for (const key of Object.keys(parsed.compilerOptions?.paths ?? {})) {
      const prefix = key.replace(/\/\*$/, "").replace(/^@/, "");
      if (prefix !== "" && !prefix.includes("/")) prefixes.add(prefix);
    }
  }
  if (prefixes.size === 0) {
    throw new Error(
      "no package tsconfig declares a path alias, so this check would match nothing",
    );
  }
  return [...prefixes].sort();
}

/**
 * Built modules and their type declarations, and nothing else.
 *
 * The anchor is what keeps source maps out: `index.js.map` ends in `.map`,
 * so it does not match, and that matters — a map carries the pre-bundle
 * source verbatim, aliases and all, while never being loaded by a bundler
 * and so never able to fail to resolve. The guard this replaces expressed
 * the same thing as a separate exclusion, which read like an oversight and
 * was in fact redundant with its own extension filter.
 *
 * Declarations are in for the same reason the modules are. An alias left
 * in a `.d.ts` resolves for nobody outside the package that wrote it, so
 * every consumer's typecheck fails on a file none of them can fix — the
 * same leak as an unresolvable import, arriving one build later.
 */
const BUNDLE = /\.(js|mjs|cjs|d\.ts|d\.mts|d\.cts)$/;

/**
 * Built output resolves on its own — no internal alias survives into it.
 *
 * `pnpm build` exits 0 when this leaks: esbuild silently externalises an
 * unknown `@shared/...` specifier as though it were a scoped npm package.
 * So a green build is not proof the output loads. What happens instead is
 * that the web app pulls in `shared/dist/index.js` at runtime, meets a bare
 * specifier nothing can resolve, and the page dies with a resolve error —
 * which is how this was found, as a regression from the refactor that moved
 * every internal import onto aliases.
 *
 * The fix for a leaking package is to make its own build resolve its own
 * aliases, not to loosen this check.
 *
 * Reads build output, so it fails when there is none: a check whose subject
 * has not been built must say "build first", never report clean because
 * there was nothing to look at.
 */
export const noUnresolvedAliasInDist = {
  name: "no-unresolved-alias-in-dist",
  description: "No internal path alias survives into built output",
  run(context: CheckContext): Finding[] {
    const aliases = internalAliases(context);
    const leaked = new RegExp(
      `(from|import|require)\\s*\\(?\\s*['"]@(${aliases.join("|")})/`,
    );

    const packages = context
      .files(
        (path) => /^packages\/[^/]+\/package\.json$/.test(path),
        "workspace packages",
      )
      .map((path) => path.split("/")[1] ?? "");

    const findings: Finding[] = [];
    for (const name of packages) {
      const bundles = context.walk(
        `packages/${name}/dist`,
        (path) => BUNDLE.test(path),
        `built modules of ${name}`,
      );

      for (const file of bundles) {
        // Comments first. A doc block may show an alias inside an @example,
        // and nothing resolves an import that exists only in prose — the
        // reason dependency-cruiser was kept for the import graph is that it
        // reads imports rather than text, and a text scan has to earn the
        // same property.
        stripComments(context.read(file), "js")
          .split("\n")
          .forEach((text, index) => {
            const hit = leaked.exec(text);
            if (hit) {
              findings.push({
                file,
                line: index + 1,
                message: `Internal alias "${hit[0]}" survived the build. Nothing resolves it at runtime, and the build exits 0 anyway — make this package's build resolve its own aliases.`,
              });
            }
          });
      }
    }
    return findings;
  },
} satisfies Check;
