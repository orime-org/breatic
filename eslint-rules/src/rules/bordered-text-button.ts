// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** The variants that draw neither a border nor a filled background. */
const BORDERLESS_VARIANTS = new Set(["ghost", "chrome-ghost"]);

/**
 * Sizes at which a borderless button still reads as pressable.
 *
 * `menu-item` is a full-width row inside a popover, where a border around
 * each row would read as a stack of boxes rather than a menu. `icon` and
 * `chrome` are the square icon forms, where the glyph and the hit area are
 * the affordance and there is no word to mistake for text.
 */
const AFFORDANT_SIZES = new Set(["menu-item", "icon", "chrome"]);

/**
 * Read a JSX attribute's value when it is a plain string.
 *
 * Handles both spellings — `size='sm'` and `size={'sm'}` — because they
 * produce different AST shapes for the same constant.
 * @param attribute - The attribute to read, or undefined when absent.
 * @returns The string, or null when absent or not statically a string.
 */
function literalValue(
  attribute: TSESTree.JSXAttribute | undefined,
): string | null {
  const value = attribute?.value;
  if (value == null) return null;
  if (value.type === AST_NODE_TYPES.Literal) {
    return typeof value.value === "string" ? value.value : null;
  }
  if (
    value.type === AST_NODE_TYPES.JSXExpressionContainer &&
    value.expression.type === AST_NODE_TYPES.Literal &&
    typeof value.expression.value === "string"
  ) {
    return value.expression.value;
  }
  return null;
}

/**
 * Find a named attribute on a JSX element, ignoring spreads.
 * @param node - The opening element to search.
 * @param name - The attribute name to find.
 * @returns The attribute, or undefined when it is not written here.
 */
function attributeNamed(
  node: TSESTree.JSXOpeningElement,
  name: string,
): TSESTree.JSXAttribute | undefined {
  return node.attributes.find(
    (a): a is TSESTree.JSXAttribute =>
      a.type === AST_NODE_TYPES.JSXAttribute &&
      a.name.type === AST_NODE_TYPES.JSXIdentifier &&
      a.name.name === name,
  );
}

/**
 * A button that carries a word carries a border.
 *
 * Without one the control is a piece of text sitting on the page, and a
 * reader has no way to know it can be pressed — which is a functional
 * failure, not a matter of taste. It reached production because the rule
 * lived only in people's heads: writing a new dialog, the nearest example
 * to copy happened to be one of the four borderless ones, so copying the
 * neighbour spread the mistake instead of the convention.
 *
 * The allowance is by size rather than by variant, and it is a list of what
 * is permitted rather than a list of what is banned. A ban on the one
 * combination that exists today (`ghost` at `sm`) would pass the identical
 * mistake written at any other size; an allowlist makes a size that nobody
 * has invented yet start out guarded.
 *
 * A variant this cannot read — `active ? 'secondary' : 'ghost'` — is left
 * alone rather than guessed at, since one branch of it is usually fine. The
 * size check still applies to those call sites through their own attribute,
 * and every dynamic one in the app today is an icon button.
 */
export const borderedTextButton = createRule({
  name: "bordered-text-button",
  meta: {
    type: "problem",
    docs: {
      description: "A button with a visible label carries a visible border",
    },
    schema: [],
    messages: {
      borderless:
        "This button has a label but no border, so it reads as plain text. Use variant='outline'. Borderless is only for size='menu-item' (a dropdown row) or the icon-only sizes 'icon' / 'chrome'.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      "JSXOpeningElement[name.name='Button']"(
        node: TSESTree.JSXOpeningElement,
      ): void {
        const variant = literalValue(attributeNamed(node, "variant"));
        if (variant === null || !BORDERLESS_VARIANTS.has(variant)) return;

        // An absent size is the default one — a 32px button built for a word.
        const size = literalValue(attributeNamed(node, "size")) ?? "default";
        if (AFFORDANT_SIZES.has(size)) return;

        context.report({ node, messageId: "borderless" });
      },
    };
  },
});
