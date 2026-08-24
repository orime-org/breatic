// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/**
 * The app has exactly one TooltipProvider, at its root.
 *
 * The provider's delay is tuned once for the whole app, and Radix's
 * skip-delay grouping — where sweeping across a row of triggers shows the
 * later tooltips immediately instead of waiting again — only holds inside a
 * single provider instance. Nesting another one silently overrides the
 * timing for that subtree and splits it into its own group. That shipped
 * twice, both times as "the tooltip appears at the wrong moment".
 *
 * Nothing needs its own provider: a Tooltip inherits the root one through
 * context, including from inside a TipTap NodeView, which renders through a
 * React portal and therefore keeps the context.
 */
export const singleTooltipProvider = createRule({
  name: "single-tooltip-provider",
  meta: {
    type: "problem",
    docs: { description: "The app renders exactly one TooltipProvider" },
    schema: [],
    messages: {
      nestedProvider:
        "Do not render another TooltipProvider — Tooltip inherits the app-level one, and nesting overrides its delay and breaks skip-delay grouping for this subtree.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      "JSXOpeningElement[name.name='TooltipProvider']"(
        node: TSESTree.JSXOpeningElement,
      ): void {
        context.report({ node, messageId: "nestedProvider" });
      },
    };
  },
});
