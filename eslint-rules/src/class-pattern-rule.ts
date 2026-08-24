// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";
import { allowMarkerLines } from "#rules/source-visitors";

/** What a caller must provide to ban a class-name pattern. */
interface ClassPatternRuleSpec {
  /** Rule id. */
  readonly name: string;
  /** One-line description for the rule's docs. */
  readonly description: string;
  /** The pattern that constitutes a violation. */
  readonly forbidden: RegExp;
  /**
   * When this matches, the whole string is left alone. The guards these
   * rules replace did this per LINE; a className is one string literal, so
   * per-string is the same thing in the cases that exist, and it is the more
   * defensible unit — an exemption should cover the class list it was
   * written for, not everything that happens to share a line.
   */
  readonly exemptWholeString?: RegExp;
  /**
   * Removed from the string before testing. Unlike the exemption above, this
   * permits one specific spelling without excusing anything else present.
   */
  readonly stripAllowed?: RegExp;
  /**
   * A comment marker that excuses the line it sits on. This is the rule's
   * own escape hatch, kept from the guard it replaces, rather than a blanket
   * eslint-disable — it names which rule is being excused and asks for a
   * reason on the same line.
   */
  readonly allowMarker?: string;
  /** Message shown on a hit. */
  readonly message: string;
}

/**
 * Builds a rule banning a class-name pattern in Tailwind class strings.
 *
 * Class names live in string literals and template chunks, which is what
 * this reads. The line-based greps these rules replace also matched
 * comments; a comment naming a banned class is documentation, not a class
 * the browser ever sees, so that is a deliberate narrowing.
 * @param spec Which pattern to ban and which spellings to permit.
 * @returns A rule module ready to register under `spec.name`.
 */
export function createClassPatternRule(
  spec: ClassPatternRuleSpec,
): TSESLint.RuleModule<"forbiddenClass", []> {
  return createRule<[], "forbiddenClass">({
    name: spec.name,
    meta: {
      type: "problem",
      docs: { description: spec.description },
      schema: [],
      messages: { forbiddenClass: spec.message },
    },
    defaultOptions: [],
    create(context) {
      const allowedLines =
        spec.allowMarker === undefined
          ? new Set<number>()
          : allowMarkerLines(context.sourceCode, spec.allowMarker);

      /**
       * Reports the node when the class string carries the banned pattern.
       * @param node Node to report on.
       * @param text The class string to test.
       */
      function check(node: TSESTree.Node, text: string): void {
        if (allowedLines.has(node.loc.start.line)) return;
        if (spec.exemptWholeString?.test(text)) return;
        const subject = spec.stripAllowed
          ? text.replace(spec.stripAllowed, "")
          : text;
        const hit = spec.forbidden.exec(subject);
        if (hit) {
          context.report({
            node,
            messageId: "forbiddenClass",
            data: { match: hit[0] },
          });
        }
      }

      return {
        Literal: (node: TSESTree.Literal): void => {
          if (typeof node.value === "string") check(node, node.value);
        },
        TemplateElement: (node: TSESTree.TemplateElement): void =>
          check(node, node.value.raw),
      };
    },
  });
}
