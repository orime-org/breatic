// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/**
 * Reads the dotted name off a callee, as it is written in the source.
 * @param callee The expression being called.
 * @returns The names joined by dots, or null when the callee is not a chain of
 *   plain identifiers.
 */
function dottedName(callee: TSESTree.Expression): string | null {
  const parts: string[] = [];
  let here: TSESTree.Node = callee;
  while (here.type === AST_NODE_TYPES.MemberExpression) {
    if (here.computed) return null;
    if (here.property.type !== AST_NODE_TYPES.Identifier) return null;
    parts.unshift(here.property.name);
    here = here.object;
  }
  if (here.type !== AST_NODE_TYPES.Identifier) return null;
  parts.unshift(here.name);
  return parts.join(".");
}

/**
 * Reads `test.describe.configure` off a callee, or answers false for anything else.
 * @param callee The expression being called.
 * @returns Whether this is Playwright's group configuration call.
 */
function isDescribeConfigure(callee: TSESTree.Expression): boolean {
  return dottedName(callee) === "test.describe.configure";
}

/**
 * Reads the group form of the same request, which takes no options object.
 *
 * Playwright spells one thing two ways. `test.describe.serial(name, fn)` puts
 * the group in serial mode with nothing to inspect but the name being called,
 * and the guard read only the other spelling until a file carrying three of
 * these passed it.
 * @param callee The expression being called.
 * @returns Whether this declares a serial group.
 */
function isSerialDescribe(callee: TSESTree.Expression): boolean {
  const name = dottedName(callee);
  return (
    name === "test.describe.serial" ||
    name === "test.describe.serial.only" ||
    name === "test.describe.only.serial"
  );
}

/**
 * Answers whether an options object asks for the serial mode.
 * @param argument The first argument passed to `configure`.
 * @returns Whether `mode` is set to the string `serial`.
 */
function asksForSerial(argument: TSESTree.CallExpressionArgument): boolean {
  if (argument.type !== AST_NODE_TYPES.ObjectExpression) return false;
  return argument.properties.some((property) => {
    if (property.type !== AST_NODE_TYPES.Property) return false;
    const named =
      property.key.type === AST_NODE_TYPES.Identifier &&
      property.key.name === "mode";
    if (!named) return false;
    return (
      property.value.type === AST_NODE_TYPES.Literal &&
      property.value.value === "serial"
    );
  });
}

/**
 * A test file never puts its cases into a serial group.
 *
 * Playwright stops a serial group at its first failure: every case after
 * the red one is reported as "did not run". Measured on this repository's
 * own suite, one failure left 54 cases unexecuted in a single run, 44 of
 * them from one file — so a run that looks like it covered the product
 * covered three quarters of it, and nothing in the output says which
 * quarter went missing.
 *
 * Serial groups get written for a reason, and the reason is usually the
 * cost of setting up: a file signs in once and shares the page. That cost
 * is real, and it is paid somewhere other than here — the suite hands each
 * case a signed-in browser state, so a case that builds its own opening
 * repeats the cheap half rather than the expensive one.
 *
 * The call is visible in the AST with nothing standing in for it, which is
 * what makes this a guard rather than a line in a document.
 */
export const noSerialTests = createRule<[], "serialGroup">({
  name: "no-serial-tests",
  meta: {
    type: "problem",
    docs: {
      description: "Test cases stand on their own rather than in a serial group",
    },
    schema: [],
    messages: {
      serialGroup:
        "A serial group reports every case after a failure as 'did not run'. Build the opening in each case instead of sharing one across the file.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression): void {
        if (isSerialDescribe(node.callee)) {
          context.report({ node, messageId: "serialGroup" });
          return;
        }
        if (!isDescribeConfigure(node.callee)) return;
        const [options] = node.arguments;
        if (options && asksForSerial(options)) {
          context.report({ node, messageId: "serialGroup" });
        }
      },
    };
  },
});
