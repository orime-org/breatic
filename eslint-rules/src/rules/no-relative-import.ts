// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";
import { moduleSourceVisitors } from "#rules/source-visitors";

/**
 * Which alias a package's own source imports itself through.
 *
 * Every package has a globally unique prefix, and that is the whole point:
 * one package's source is regularly compiled inside another's resolution
 * context, so a shared `@/` would have to resolve to two different src
 * directories at once. Unique prefixes make an import mean the same thing
 * no matter who is doing the importing.
 */
const PACKAGE_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["packages/shared/", "@shared"],
  ["packages/core/", "@core"],
  ["packages/domain/", "@domain"],
  ["packages/server/", "@server"],
  ["packages/worker/", "@worker"],
  ["packages/collab/", "@collab"],
  ["packages/web/", "@web"],
];

/**
 * A specifier resolved against the importing file rather than by name.
 *
 * Covers the bare forms too — `"."` and `".."` name a directory's index
 * and are every bit as positional as `"./index"`. Nothing in the repo
 * writes them today; the guard's regex required a slash, so they would
 * have been a silent way through.
 */
const RELATIVE_SPECIFIER = /^\.\.?(\/|$)/;

/**
 * Names the alias the file in question should be importing through.
 *
 * The message is worth this much effort: a guard that names the one right
 * answer for this file is acted on, where a guard that lists all seven
 * leaves the reader to work out which row is theirs.
 * @param filename Absolute path of the file being linted.
 * @returns The package's alias prefix, or a generic phrase if unrecognised.
 */
function aliasFor(filename: string): string {
  const normalised = filename.replace(/\\/g, "/");
  const hit = PACKAGE_ALIASES.find(([dir]) => normalised.includes(dir));
  return hit ? `${hit[1]}/*` : "the package's alias";
}

/**
 * Source imports through path aliases, never relative paths.
 *
 * A relative path encodes where a file sits relative to its importer, so
 * moving either end silently rewrites the meaning of every `../` between
 * them. An alias names the target instead of the route to it.
 *
 * Tests are exempt, in the config rather than here: they are not shipped,
 * so the resolution concern that motivates the rule does not reach them.
 *
 * Wider than the guard it replaces in one measured way — the guard read
 * literal `from './x'` text, so a dynamic `import('./x')` was invisible to
 * it. Narrower in another, and deliberately: prose in a doc comment that
 * happens to contain `from './y'` is not an import, and the guard had to
 * run a comment stripper to avoid it. The AST never sees comments at all.
 */
export const noRelativeImport = createRule<[], "noRelativeImport">({
  name: "no-relative-import",
  meta: {
    type: "problem",
    docs: {
      description: "Source imports through path aliases, not relative paths",
    },
    schema: [],
    messages: {
      noRelativeImport:
        "'{{specifier}}' is a relative import. Source imports through {{alias}} — a relative path breaks as soon as either file moves.",
    },
  },
  defaultOptions: [],
  create(context) {
    const alias = aliasFor(context.filename);
    return moduleSourceVisitors(
      (node: TSESTree.Node, source: TSESTree.StringLiteral): void => {
        if (RELATIVE_SPECIFIER.test(source.value)) {
          context.report({
            node,
            messageId: "noRelativeImport",
            data: { specifier: source.value, alias },
          });
        }
      },
    );
  },
});
