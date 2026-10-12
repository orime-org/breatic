// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** The elements whose waiting state the Button primitive draws. */
const BUTTONS = new Set(["Button", "AlertDialogAction"]);

/** The lucide spinner, under each name the package exports it by. */
const SPINNERS = new Set([
  "Loader2",
  "Loader2Icon",
  "LoaderCircle",
  "LoaderCircleIcon",
  "LucideLoader2",
  "LucideLoaderCircle",
]);

/**
 * The name a JSX element is written with, when it is a plain identifier.
 * @param name - The element's name node.
 * @returns The identifier, or null for member and namespaced names.
 */
function elementName(name: TSESTree.JSXTagNameExpression): string | null {
  return name.type === AST_NODE_TYPES.JSXIdentifier ? name.name : null;
}

/**
 * A button that waits for the server says so through `loading` on the Button
 * primitive, which disables presses, keeps focus and draws the spinner in one
 * place (inner#1374). A spinner written into a button by hand is a second
 * spelling of that state: it carries none of the press handling, and every
 * copy picks its own size and spacing.
 *
 * Anything rendered inside a `Button` or an `AlertDialogAction` counts,
 * including the JSX passed as its `icon`, because all of it ends up inside the
 * one `<button>` element.
 */
export const noHandWrittenButtonSpinner = createRule({
  name: "no-hand-written-button-spinner",
  meta: {
    type: "problem",
    docs: { description: "A button's waiting spinner comes from Button's loading prop" },
    schema: [],
    messages: {
      handWrittenSpinner:
        "Pass `loading` to the Button (and its leading icon as `icon`) instead of drawing a spinner inside it. `loading` also swallows presses and keeps keyboard focus on the button.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXOpeningElement(node: TSESTree.JSXOpeningElement): void {
        const name = elementName(node.name);
        if (name === null || !SPINNERS.has(name)) return;
        // Program's parent is null at runtime although the type says undefined.
        for (
          let parent: TSESTree.Node | null | undefined = node.parent.parent;
          parent != null;
          parent = parent.parent
        ) {
          if (parent.type !== AST_NODE_TYPES.JSXElement) continue;
          const outer = elementName(parent.openingElement.name);
          if (outer !== null && BUTTONS.has(outer)) {
            context.report({ node, messageId: "handWrittenSpinner" });
            return;
          }
        }
      },
    };
  },
});
