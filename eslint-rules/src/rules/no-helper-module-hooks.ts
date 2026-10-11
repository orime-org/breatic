// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** The calls that bind to whichever test file is being loaded when they run. */
const FILE_BOUND = new Set(["beforeEach", "afterEach", "beforeAll", "afterAll", "use"]);

/**
 * Reads the call a top-level statement makes, looking through one `await`.
 * @param statement A statement in the module body.
 * @returns The call, or null when the statement is not a call.
 */
function topLevelCall(statement: TSESTree.ProgramStatement): TSESTree.CallExpression | null {
  if (statement.type !== AST_NODE_TYPES.ExpressionStatement) return null;
  const expression =
    statement.expression.type === AST_NODE_TYPES.AwaitExpression
      ? statement.expression.argument
      : statement.expression;
  return expression.type === AST_NODE_TYPES.CallExpression ? expression : null;
}

/**
 * Answers whether a call registers a hook or sets options on a test object.
 * @param call The call expression.
 * @returns Whether it is `<identifier>.beforeEach(...)` or one of its siblings.
 */
function isFileBound(call: TSESTree.CallExpression): boolean {
  const { callee } = call;
  return (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.object.type === AST_NODE_TYPES.Identifier &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    FILE_BOUND.has(callee.property.name)
  );
}

/**
 * A test helper module registers no hooks and sets no options at its top level.
 *
 * A module runs once per worker, so a hook written at a helper's top level is
 * bound to the first test file that imports it and to no other. The files
 * that import the helper later run without its setup and its cleanup, and
 * nothing reports the difference: one case reads an empty tab strip, another
 * leaves a Space behind for the next file to land on. Which file is first
 * depends on the order the run picks, so the same file passes alone and
 * fails in the suite.
 *
 * The helper hands its setup and cleanup out as fixtures on a `test` it
 * exports, and a file that wants them imports that `test`.
 */
export const noHelperModuleHooks = createRule<[], "moduleHook">({
  name: "no-helper-module-hooks",
  meta: {
    type: "problem",
    docs: {
      description: "Test helpers hand out setup and cleanup as fixtures, not module-level hooks",
    },
    schema: [],
    messages: {
      moduleHook:
        "A hook or test.use at a helper's top level binds to the first test file that imports the helper and to no other. Export a test with an auto fixture instead.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      Program(program: TSESTree.Program): void {
        for (const statement of program.body) {
          const call = topLevelCall(statement);
          if (call && isFileBound(call)) context.report({ node: call, messageId: "moduleHook" });
        }
      },
    };
  },
});
