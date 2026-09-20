// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** Node types a case body can be written as. */
const FUNCTION_BODIES = new Set<AST_NODE_TYPES>([
  AST_NODE_TYPES.ArrowFunctionExpression,
  AST_NODE_TYPES.FunctionExpression,
  AST_NODE_TYPES.FunctionDeclaration,
]);

/**
 * Reads `test.skip` off a callee, or answers false for anything else.
 * @param callee The expression being called.
 * @returns Whether this is Playwright's skip.
 */
function isTestSkip(callee: TSESTree.Expression): boolean {
  if (callee.type !== AST_NODE_TYPES.MemberExpression) return false;
  const { object, property } = callee;
  return (
    property.type === AST_NODE_TYPES.Identifier &&
    property.name === "skip" &&
    object.type === AST_NODE_TYPES.Identifier &&
    object.name === "test"
  );
}

/**
 * Answers whether a call declares a case rather than leaving one.
 *
 * Playwright declares a skipped case two ways — `test.skip(title, body)` and
 * `test.skip(title, details, body)` (`playwright/types/test.d.ts:4343` and
 * `:4424`) — and what they share is a title first and a body last. The three
 * shapes that exit mid-run never have both: `skip()` takes nothing,
 * `skip(condition, description?)` opens on a value rather than a title, and
 * `skip(callback, description?)` opens on a function.
 * @param args The call's arguments.
 * @returns Whether a title opens the call and a body closes it.
 */
function declaresACase(args: TSESTree.CallExpressionArgument[]): boolean {
  const first = args[0];
  const last = args[args.length - 1];
  if (first === undefined || last === undefined || first === last) return false;
  const titled =
    first.type === AST_NODE_TYPES.Literal && typeof first.value === "string";
  return titled && FUNCTION_BODIES.has(last.type);
}

/**
 * A case runs or it is not in the selection; it never skips itself.
 *
 * `test.skip(title, body)` names a case that will not run, and the report
 * says so with a title anyone can read. The shapes that open on a condition
 * instead — `skip()`, `skip(condition, reason)`, `skip(callback, reason)` —
 * step over cases while the run is on, and what lands in the report is
 * "skipped" with a zero exit code, which reads as nothing to see here.
 *
 * Both places that shape can sit do the same damage. Inside a case body it
 * takes that case; at file scope it takes the file, and the run that started
 * this work reported 12 passed and 289 skipped with a zero exit code from one
 * such line — `test.skip(!email || !password, ...)` above the cases.
 *
 * What replaces it: a precondition the suite builds (setup makes the
 * accounts, studios and Projects), or a scenario tag, which keeps the case
 * out of the default selection rather than inside it and silent.
 */
export const noRuntimeTestSkip = createRule<[], "runtimeSkip">({
  name: "no-runtime-test-skip",
  meta: {
    type: "problem",
    docs: {
      description: "A case declares what it needs rather than skipping mid-run",
    },
    schema: [],
    messages: {
      runtimeSkip:
        "A conditional skip lands in the report as 'skipped' with a zero exit code, whether it takes one case or the whole file. Build the precondition in setup, or tag the case so it stays out of the default selection.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression): void {
        if (!isTestSkip(node.callee)) return;
        if (declaresACase(node.arguments)) return;
        context.report({ node, messageId: "runtimeSkip" });
      },
    };
  },
});
