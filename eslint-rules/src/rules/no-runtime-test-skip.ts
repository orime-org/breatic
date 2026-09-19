// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** Node types that mean the surrounding code runs as part of a case. */
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
 * `test.skip(title, body)` names a case that will not run; the body given
 * as the second argument is what marks it as a declaration. Every other
 * shape — one argument, or a condition and a reason — exits whatever is
 * currently running.
 * @param args The call's arguments.
 * @returns Whether the second argument is a function.
 */
function declaresACase(args: TSESTree.CallExpressionArgument[]): boolean {
  const second = args[1];
  return second !== undefined && FUNCTION_BODIES.has(second.type);
}

/**
 * Answers whether a node sits inside a function body.
 * @param node The node to trace upwards from.
 * @returns Whether any ancestor is a function.
 */
function insideAFunction(node: TSESTree.Node): boolean {
  for (let here = node.parent; here; here = here.parent) {
    if (FUNCTION_BODIES.has(here.type)) return true;
  }
  return false;
}

/**
 * A case never steps over itself part-way through.
 *
 * `test.skip` at the top of a file is a declaration: the report says the
 * case was skipped before anything opened a browser, and the reason is a
 * fact about the machine. The same call inside a case body is something
 * else — the case started, looked at the screen, and left. It lands in the
 * report as "skipped", which reads as "nothing to see here", and the exit
 * code stays zero.
 *
 * The two shapes measured in this repository were "this deployment serves
 * fewer than five voices" and "this account has only one project". Both
 * describe a precondition the suite can build instead of tiptoeing around:
 * the second project now comes from setup, and a case whose precondition
 * genuinely belongs to the machine carries a scenario tag, which keeps it
 * out of the default selection entirely rather than inside it and silent.
 *
 * Being inside a function body is the whole judgement, and the AST answers
 * it outright.
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
        "A skip inside a case body lands in the report as 'skipped' with a zero exit code. Build the precondition in setup, or tag the case so it stays out of the default selection.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression): void {
        if (!isTestSkip(node.callee)) return;
        if (declaresACase(node.arguments)) return;
        if (!insideAFunction(node)) return;
        context.report({ node, messageId: "runtimeSkip" });
      },
    };
  },
});
