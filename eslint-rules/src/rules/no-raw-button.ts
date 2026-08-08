// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/**
 * Outside the vendor directory, a button is written with the `Button`
 * primitive.
 *
 * One element, two spellings, is how a guard ends up blind. A rule about what
 * buttons look like can only see the spelling it was taught, so the other one
 * accumulates whatever nobody checked — which is exactly what happened: three
 * borderless words shipped in the canvas while a rule watched the component
 * and reported clean.
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
 * untouched; `className` merges over the variant classes rather than losing
 * to them; and `asChild` hands the element to another primitive when one owns
 * it. Anything a bare `<button>` can do, `<Button>` can do.
 *
 * The vendor directory is exempt because that is where the element is
 * legitimately written — `Button` itself renders one.
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
    };
  },
});
