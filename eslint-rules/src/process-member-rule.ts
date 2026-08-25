// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** What a caller must provide to ban one member of the process object. */
interface ProcessMemberRuleSpec {
  /** Rule id. */
  readonly name: string;
  /** One-line description for the rule's docs. */
  readonly description: string;
  /** The member of `process` that libraries must not reach for. */
  readonly member: string;
  /** Message shown on a hit. */
  readonly message: string;
}

/**
 * Builds a rule banning one member of the `process` object from a scope.
 *
 * Two rules were this shape written twice — same pair of selectors, same
 * report, differing only in a name and a sentence. Both carry the same
 * documented boundary, that a destructured binding or a trip through
 * `globalThis` is not flagged, and the point of one definition is that
 * closing that boundary later closes it for both rather than for whichever
 * one somebody remembered.
 *
 * Both spellings of the access, because `process["env"]` reads the same
 * property as `process.env` and a rule that watched only the dotted form
 * would guard punctuation rather than the constraint.
 * @param spec Which member to ban and how to explain the ban.
 * @returns A rule module ready to register under `spec.name`.
 */
export function createProcessMemberRule(
  spec: ProcessMemberRuleSpec,
): TSESLint.RuleModule<"forbiddenMember", []> {
  return createRule<[], "forbiddenMember">({
    name: spec.name,
    meta: {
      type: "problem",
      docs: { description: spec.description },
      schema: [],
      messages: { forbiddenMember: spec.message },
    },
    defaultOptions: [],
    create(context) {
      return {
        [[
          `MemberExpression[computed=false][object.name='process'][property.name='${spec.member}']`,
          `MemberExpression[computed=true][object.name='process'][property.value='${spec.member}']`,
        ].join(", ")](node: TSESTree.MemberExpression): void {
          context.report({ node, messageId: "forbiddenMember" });
        },
      };
    },
  });
}
