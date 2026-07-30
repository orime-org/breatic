// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";
import { stringLiteralVisitors } from "#rules/source-visitors";

/** What a caller must provide to ban a set of tokens from a scope. */
interface ForbiddenTokenRuleSpec {
  /** Rule id. */
  readonly name: string;
  /** One-line description for the rule's docs. */
  readonly description: string;
  /**
   * Tokens that must not appear. A token made of word characters is matched
   * on word boundaries so it does not fire inside a longer name; one that
   * starts or ends with punctuation (a key prefix like `:session:`) is
   * matched as-is, since a boundary there would never hold.
   */
  readonly tokens: readonly string[];
  /** Message shown on a hit; `{{token}}` is filled in. */
  readonly message: string;
}

/**
 * Builds a rule banning a set of tokens from wherever it is configured.
 *
 * These invariants are about a NAME — a table, a key prefix — appearing at
 * all, not about a code structure, so the check reads identifiers, string
 * literals and template chunks. Working on the AST still buys two things
 * over the text scan it replaces: comments never match, because they are not
 * in the tree at all, and the report lands on the node rather than on a line
 * number computed from stripped text.
 * @param spec Which tokens to ban and how to explain the ban.
 * @returns A rule module ready to register under `spec.name`.
 */
export function createForbiddenTokenRule(
  spec: ForbiddenTokenRuleSpec,
): TSESLint.RuleModule<"forbiddenToken", []> {
  const pattern = new RegExp(
    spec.tokens
      .map((token) => {
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const lead = /^\w/.test(token) ? "\\b" : "";
        const trail = /\w$/.test(token) ? "\\b" : "";
        return `${lead}${escaped}${trail}`;
      })
      .join("|"),
  );

  return createRule<[], "forbiddenToken">({
    name: spec.name,
    meta: {
      type: "problem",
      docs: { description: spec.description },
      schema: [],
      messages: { forbiddenToken: spec.message },
    },
    defaultOptions: [],
    create(context) {
      // A shorthand `import { x }` gives `imported` and `local` as separate
      // nodes over the same characters, so without this the same text is
      // reported twice.
      const reported = new Set<string>();

      /**
       * Reports the node when the text carries a banned token.
       * @param node Node to report on.
       * @param text Text to search.
       */
      function check(node: TSESTree.Node, text: string): void {
        const hit = pattern.exec(text);
        if (!hit) return;
        const span = `${node.range[0]}:${node.range[1]}`;
        if (reported.has(span)) return;
        reported.add(span);
        context.report({
          node,
          messageId: "forbiddenToken",
          data: { token: hit[0] },
        });
      }

      return {
        // An identifier is this rule's own concern; the two string forms are
        // the shared pair, so the backtick half cannot drift out of one copy.
        Identifier: (node: TSESTree.Identifier): void => check(node, node.name),
        ...stringLiteralVisitors(check),
      };
    },
  });
}

