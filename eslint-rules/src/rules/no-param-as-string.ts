// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/**
 * Whether the expression is a call to a `param` method.
 * @param node The expression the assertion is applied to.
 * @returns True for `x.param(...)` in any receiver shape.
 */
function isParamCall(node: TSESTree.Expression): boolean {
  return (
    node.type === AST_NODE_TYPES.CallExpression &&
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.property.type === AST_NODE_TYPES.Identifier &&
    node.callee.property.name === "param"
  );
}

/**
 * A route parameter must be validated, not asserted into a string.
 *
 * Hono's `c.req.param(name)` returns `string | undefined` — the parameter is
 * missing whenever the route did not match the way the handler assumes.
 * `as string` erases that `undefined` without checking for it, so the value
 * flows on as a string that may not exist and fails somewhere further down,
 * far from the route that produced it. Validate at the boundary instead.
 */
export const noParamAsString = createRule({
  name: "no-param-as-string",
  meta: {
    type: "problem",
    docs: {
      description:
        "Route parameters must be validated rather than asserted into a string",
    },
    schema: [],
    messages: {
      noParamAssertion:
        "Do not assert a route parameter into a string — param() can return undefined. Validate it at the boundary and fail with a clear error.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      // `string` only — `as string[]` is a different shape and the guard
      // this replaces excluded it too.
      "TSAsExpression[typeAnnotation.type='TSStringKeyword']"(
        node: TSESTree.TSAsExpression,
      ): void {
        if (isParamCall(node.expression)) {
          context.report({ node, messageId: "noParamAssertion" });
        }
      },
    };
  },
});
