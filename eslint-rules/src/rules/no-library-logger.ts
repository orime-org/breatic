// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";
import { isLoggerLevelAccess } from "#rules/logger-shape";

/**
 * Reads the accessed member's name, used only to fill in the message.
 * @param node The member expression the selector matched.
 * @returns The member name, or an empty string when the key is computed
 *   from a non-literal expression.
 */
function memberName(node: TSESTree.MemberExpression): string {
  return node.property.type === AST_NODE_TYPES.Identifier
    ? node.property.name
    : "";
}

/**
 * Library packages must not log.
 *
 * Only the application layer knows the `userId` / `requestId` / `projectId`
 * a log line needs, whether the caller should see the failure, and whether
 * it warrants an alert. A library either throws — the original error or a
 * typed one the caller can branch on — or returns a sentinel the caller
 * turns into the right outcome. Audit lines such as `user_registered` or
 * `payment_completed` belong in the route handler that called the service.
 *
 * `console.*` counts as logging, so it is forbidden on the same grounds.
 *
 * The logger module itself is exempt: it defines the very primitives this
 * rule keeps out of everything else.
 */
export const noLibraryLogger = createRule({
  name: "no-library-logger",
  meta: {
    type: "problem",
    docs: {
      description:
        "Library packages must throw or return a sentinel rather than log",
    },
    schema: [],
    messages: {
      noLoggerCall:
        "Library packages must not call logger.{{method}} — throw or return a sentinel, and let the application layer log with its context.",
      noConsoleCall:
        "Library packages must not call console.{{method}} — console output is logging too. Throw or return a sentinel instead.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      MemberExpression(node: TSESTree.MemberExpression): void {
        // Any logger, not only a bare `logger` identifier: a scoped, child
        // or injected one is the shape most likely to appear inside a class
        // or a service, and the guard this replaces matched all of them.
        if (!isLoggerLevelAccess(node)) return;
        context.report({
          node,
          messageId: "noLoggerCall",
          data: { method: memberName(node) },
        });
      },
      "MemberExpression[computed=false][object.name='console']"(
        node: TSESTree.MemberExpression,
      ): void {
        context.report({
          node,
          messageId: "noConsoleCall",
          data: { method: memberName(node) },
        });
      },
    };
  },
});
