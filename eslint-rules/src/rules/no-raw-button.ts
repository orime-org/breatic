// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/**
 * Everywhere but the file that defines it, a button is written with the
 * `Button` primitive.
 *
 * One element, two spellings, is how a check ends up blind: it can only see
 * the spelling it was taught, so the other one accumulates whatever nobody
 * looked at. That is not hypothetical — three borderless words shipped in the
 * canvas written as bare `<button>`, while the border check of the day looked
 * at the component and reported clean. That check is gone (borders are judged
 * by a person looking at the screen; see `packages/web/CLAUDE.md`), but its
 * lesson outlives it: whatever asks a question about buttons next, machine or
 * human, should have one element to ask it about.
 *
 * The ban is flat on purpose. A selective version — report a hand-written
 * button only when it carries a word — turns every ambiguous child into a
 * judgement the rule makes silently (is a `×` character a label or a glyph,
 * is `{label}` text, is `{MAP[k]}`), and re-creates the same gap one layer
 * down. One spelling ends the question rather than answering it case by case.
 *
 * Nothing is given up for it. `Button` extends
 * `React.ButtonHTMLAttributes<HTMLButtonElement>` and spreads what it gets,
 * so `type`, `role`, `aria-*`, `data-*` and any classes pass through
 * untouched; `className` merges with the variant classes (same utility group,
 * the caller wins); and `asChild` hands the element to another primitive when
 * one owns it. Anything a bare `<button>` can do, `<Button>` can do.
 *
 * Exempt by provenance, not by directory: the single excused file is
 * `components/ui/button.tsx`, because that is where `Button` legitimately
 * renders the element. The rest of `components/ui/` is not — it also holds
 * first-party controls such as `password-input`. The config additionally
 * lists the `_dev` gallery and tests.
 */
export const noRawButton = createRule({
  name: "no-raw-button",
  meta: {
    type: "problem",
    docs: { description: "Buttons come from the Button primitive" },
    schema: [],
    messages: {
      rawButton:
        "Write this with the Button primitive from components/ui rather than a bare <button>. It takes every native attribute, so role / aria-* / data-* and your classes come through unchanged, and asChild covers a trigger another primitive owns.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      "JSXOpeningElement[name.name='button']"(
        node: TSESTree.JSXOpeningElement,
      ): void {
        context.report({ node, messageId: "rawButton" });
      },
      // The factory call renders the identical element, so a rule that watched
      // JSX alone would ban one way of writing it and leave the other open.
      CallExpression(node: TSESTree.CallExpression): void {
        const callee = node.callee;
        const name =
          callee.type === AST_NODE_TYPES.Identifier
            ? callee.name
            : callee.type === AST_NODE_TYPES.MemberExpression &&
                callee.property.type === AST_NODE_TYPES.Identifier
              ? callee.property.name
              : null;
        if (name !== "createElement" && name !== "jsx" && name !== "jsxs") {
          return;
        }
        const first = node.arguments[0];
        if (
          first !== undefined &&
          first.type === AST_NODE_TYPES.Literal &&
          first.value === "button"
        ) {
          context.report({ node, messageId: "rawButton" });
        }
      },
    };
  },
});
