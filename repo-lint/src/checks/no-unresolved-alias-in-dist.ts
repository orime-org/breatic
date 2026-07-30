// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * Every alias that only the build understands.
 *
 * Seven package prefixes plus `@locales`, which the guard this replaces
 * did not list — it is declared in the web package's tsconfig and would
 * have leaked as silently as any other. `@breatic/shared` is deliberately
 * absent: that is a real workspace package name and resolves at runtime.
 */
const INTERNAL_ALIASES = [
  "shared",
  "core",
  "domain",
  "collab",
  "worker",
  "server",
  "web",
  "locales",
];

/**
 * An alias surviving into built output, in any form that loads a module.
 *
 * `require` is in the alternation where the guard had only `from|import`.
 * Nothing in the repo emits CommonJS today, so that gap was latent rather
 * than live — but a build format is a configuration line away from
 * changing, and a guard that only covers today's output format is one
 * config change from silent.
 */
const LEAKED_ALIAS = new RegExp(
  `(from|import|require)\\s*\\(?\\s*['"]@(${INTERNAL_ALIASES.join("|")})/`,
);

/** Built modules. */
const BUNDLE = /\.(js|mjs|cjs)$/;

/**
 * Source maps carry the pre-bundle source, aliases and all.
 *
 * They are not loaded by a bundler and cannot fail to resolve, so a hit in
 * one is noise. This exclusion is undocumented in the guard and reads like
 * an oversight; it is load-bearing.
 */
const SOURCE_MAP = /\.map$/;

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
        (path) => BUNDLE.test(path) && !SOURCE_MAP.test(path),
        `built modules of ${name}`,
      );

      for (const file of bundles) {
        context
          .read(file)
          .split("\n")
          .forEach((text, index) => {
            const hit = LEAKED_ALIAS.exec(text);
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
