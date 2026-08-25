// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** Drizzle members that expose a raw table row. */
const ROW_TYPE_MEMBERS = /^\$infer(Select|Insert)$/;

/**
 * Drizzle's inferred row types must not leave the repo that owns the table.
 *
 * `typeof table.$inferSelect` is the shape of a database row, column names
 * and all. Handing it to a caller makes every consumer depend on the schema:
 * renaming a column then ripples out through services, routes and the wire
 * format. A repo maps rows to a domain entity at its boundary, so the schema
 * stays an implementation detail of the one module that owns the table.
 *
 * Repos themselves are exempt — mapping the row is exactly their job.
 */
export const noDrizzleTypeLeak = createRule({
  name: "no-drizzle-type-leak",
  meta: {
    type: "problem",
    docs: {
      description:
        "Drizzle inferred row types stay inside the repo that owns the table",
    },
    schema: [],
    messages: {
      noTypeLeak:
        "Drizzle's {{member}} must not leave the repo — map the row to a domain entity so callers never depend on the table's columns.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      // Type position: `typeof users.$inferSelect` parses as a qualified name
      // inside a type query, not as a member expression.
      [`TSQualifiedName[right.name=${ROW_TYPE_MEMBERS}]`](
        node: TSESTree.TSQualifiedName,
      ): void {
        context.report({
          node,
          messageId: "noTypeLeak",
          data: { member: node.right.name },
        });
      },
      // Value position: rarer, but the regex guard this replaces matched it.
      [`MemberExpression[computed=false][property.name=${ROW_TYPE_MEMBERS}]`](
        node: TSESTree.MemberExpression,
      ): void {
        context.report({
          node,
          messageId: "noTypeLeak",
          data: {
            member: context.sourceCode.getText(node.property),
          },
        });
      },
    };
  },
});
