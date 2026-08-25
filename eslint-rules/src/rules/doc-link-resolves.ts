// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { TSESLint } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/**
 * A doc-comment link and whatever it points at.
 *
 * All three spellings — link, linkcode and linkplain — because they differ
 * only in how the target is rendered, and a dangling one of any spelling is
 * equally dead. The target runs to the first space, pipe or closing brace,
 * since everything after those is display text rather than the name.
 *
 * Written without spelling an inline tag out: this file would otherwise
 * carry tags with no content and be reported by the documentation linter.
 */
const LINK = /\{@link(?:code|plain)?\s+([^}\s|]+)/g;

/**
 * Targets that are not symbols and have no name to resolve.
 *
 * A relative path names a directory of the source tree and a URL names a
 * page; neither is something a scope can hold, and reporting them would
 * make the rule wrong about the two forms it should say nothing about.
 */
const NOT_A_SYMBOL = /^(\.\.?\/|[a-z][a-z0-9+.-]*:)/i;

/**
 * Every name in a doc-comment link exists in the file that writes it.
 *
 * A comment is the one thing this repository produces that nothing checks.
 * Code is checked by the compiler, by tests and by running; a sentence
 * pointing at a function that moved out of the repository months ago stays
 * behind and misleads whoever reads it next.
 *
 * This is a rule rather than a pass of the documentation generator because
 * the generator only ever sees the exported surface. This repository
 * mandates a doc comment on every named function, exported or not, so most
 * comments here live on symbols the generator never builds a page for —
 * their dangling links were invisible to it, while a perfectly good link
 * pointing at a private symbol was reported for the unrelated sin of not
 * appearing in the published documentation. The check was inverted exactly
 * where the mandate puts most of the comments.
 *
 * Resolution is the file's whole world: everything it declares at any
 * depth, plus everything it imports. That is the same world an editor
 * resolves the link in, so a name this rule cannot find is a name the
 * reader's editor will not jump to either. A symbol that genuinely lives
 * elsewhere goes in backticks — it is prose, not a link, and writing it as
 * a link promises a jump that was never going to work.
 */
export const docLinkResolves = createRule<[], "unresolvedLink">({
  name: "doc-link-resolves",
  meta: {
    type: "problem",
    docs: { description: "Doc-comment links name something that exists" },
    schema: [],
    messages: {
      unresolvedLink:
        "{@link {{name}}} names nothing this file declares or imports, so the link goes nowhere here — an editor will not jump to it and neither will a reader. Import the symbol, or write it in backticks if it lives somewhere else.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      Program(): void {
        const known = new Set<string>();
        for (const scope of context.sourceCode.scopeManager?.scopes ?? []) {
          for (const variable of scope.variables) known.add(variable.name);
        }

        for (const comment of context.sourceCode.getAllComments()) {
          for (const [, target] of comment.value.matchAll(LINK)) {
            const raw = target ?? "";
            if (NOT_A_SYMBOL.test(raw)) continue;
            // A qualified name resolves through its root: `Model.mode` is
            // reachable exactly when `Model` is.
            const name = raw.split(".")[0] ?? "";
            if (name.length === 0 || known.has(name)) continue;
            context.report({
              loc: comment.loc,
              messageId: "unresolvedLink",
              data: { name },
            });
          }
        }
      },
    };
  },
}) satisfies TSESLint.RuleModule<"unresolvedLink", []>;
