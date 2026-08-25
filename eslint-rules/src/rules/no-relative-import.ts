// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { posix } from "node:path";
import { type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";
import { moduleSourceVisitors } from "#rules/source-visitors";

/**
 * Where each package's own source lives, and what it imports itself as.
 *
 * Every package has a globally unique prefix, and that is the whole point:
 * one package's source is regularly compiled inside another's resolution
 * context, so a shared `@/` would have to resolve to two different src
 * directories at once. Unique prefixes make an import mean the same thing
 * no matter who is doing the importing.
 *
 * `eslint-rules` is here too, under the Node subpath import its own
 * package.json declares. It is a different mechanism from the tsconfig
 * aliases above it, but the same rule for the reader: name the target, do
 * not describe the route to it.
 */
export const PACKAGE_ROOTS: ReadonlyArray<readonly [string, string]> = [
  ["packages/shared/src/", "@shared"],
  ["packages/core/src/", "@core"],
  ["packages/domain/src/", "@domain"],
  ["packages/server/src/", "@server"],
  ["packages/worker/src/", "@worker"],
  ["packages/collab/src/", "@collab"],
  ["packages/web/src/", "@web"],
  ["eslint-rules/src/", "#rules"],
  ["repo-lint/src/", "#repo-lint"],
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

/** Where a file sits: which package root contains it, and under what alias. */
interface FileLocation {
  /** Absolute path of the package's source root, slash-normalised. */
  readonly root: string;
  /** The prefix imports into that root are written with. */
  readonly prefix: string;
  /** The file's own path relative to `root`. */
  readonly relative: string;
}

/**
 * Locates the file inside one of the package source roots.
 * @param filename Absolute path of the file being linted.
 * @returns Its root, prefix and relative path, or null if outside them all.
 */
function locate(filename: string): FileLocation | null {
  const normalised = filename.replace(/\\/g, "/");
  for (const [suffix, prefix] of PACKAGE_ROOTS) {
    const at = normalised.lastIndexOf(suffix);
    if (at === -1) continue;
    const root = normalised.slice(0, at + suffix.length);
    return { root, prefix, relative: normalised.slice(root.length) };
  }
  return null;
}

/**
 * Rewrites a relative specifier as the alias path naming the same file.
 *
 * Derived from the linted file's own path rather than from the working
 * directory, so the answer does not depend on where eslint was invoked.
 * @param where The importing file's location.
 * @param specifier The relative specifier to rewrite.
 * @returns The alias specifier, or null when the target is outside the root.
 */
function toAlias(where: FileLocation, specifier: string): string | null {
  const fromDir = posix.dirname(where.relative);
  const target = posix.normalize(posix.join(fromDir, specifier));
  // `..` climbing past the package root cannot be expressed as an alias;
  // it is also a cross-package import, which is a different violation.
  if (target === ".." || target.startsWith("../")) return null;
  const inside = target === "." ? "" : target.replace(/\/$/, "");
  return inside === "" ? where.prefix : `${where.prefix}/${inside}`;
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
 * Replaces both a text guard and a third-party plugin that had been doing
 * half of this each. The guard read literal `from './x'`, so a dynamic
 * `import('./x')` was invisible to it; the plugin visited only
 * `ImportDeclaration`, so `export { x } from './y'` was invisible to that.
 * The plugin also resolved its root through the working directory, which
 * makes the answer depend on where eslint was invoked — this derives the
 * root from the linted file's own path instead.
 *
 * Narrower than the text guard in one deliberate way: prose in a doc
 * comment containing `from './y'` is not an import, and the guard needed a
 * comment stripper to avoid it. The AST never sees comments at all.
 */
export const noRelativeImport = createRule<[], "noRelativeImport">({
  name: "no-relative-import",
  meta: {
    type: "problem",
    docs: {
      description: "Source imports through path aliases, not relative paths",
    },
    fixable: "code",
    schema: [],
    messages: {
      noRelativeImport:
        "'{{specifier}}' is a relative import. Source imports through {{alias}} — a relative path breaks as soon as either file moves.",
    },
  },
  defaultOptions: [],
  create(context) {
    const where = locate(context.filename);
    const alias = where === null ? "the package's alias" : `${where.prefix}/*`;

    return moduleSourceVisitors(
      (node: TSESTree.Node, source: TSESTree.StringLiteral): void => {
        if (!RELATIVE_SPECIFIER.test(source.value)) return;

        const rewritten = where === null ? null : toAlias(where, source.value);
        // Keep the quote character the file already uses — web writes single
        // quotes, the backend packages double. A fix that flips the style
        // makes a whitespace-shaped diff out of a one-word change.
        const quote = source.raw.startsWith("'") ? "'" : '"';
        context.report({
          node,
          messageId: "noRelativeImport",
          data: { specifier: source.value, alias },
          fix:
            rewritten === null
              ? undefined
              : (fixer: TSESLint.RuleFixer): TSESLint.RuleFix =>
                  fixer.replaceText(source, `${quote}${rewritten}${quote}`),
        });
      },
    );
  },
});
