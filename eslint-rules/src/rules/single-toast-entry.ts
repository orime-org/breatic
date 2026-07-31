// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { createRule } from "#rules/create-rule";
import { moduleSourceVisitors } from "#rules/source-visitors";

/**
 * Toasts go through the app's own wrapper, never straight from sonner.
 *
 * The wrapper holds two invariants that cannot be enforced at each call
 * site. It exposes only the typed variants — error, warning, success, info —
 * so a toast always carries a severity, where an untyped one renders
 * neutral and loses the signal. And it gives each toast an id derived from
 * its type and message, so repeating the same toast refreshes the one on
 * screen instead of stacking copies, while different messages still stack.
 *
 * Every way of naming the module counts, not just `import`. Re-exporting is
 * precisely how one routes around a wrapper — every consumer then imports
 * from a module of ours and still receives the untyped toast — so a rule
 * watching only import declarations guards the form people happen to write
 * rather than the constraint.
 */
export const singleToastEntry = createRule({
  name: "single-toast-entry",
  meta: {
    type: "problem",
    docs: { description: "Toasts go through the app's wrapper, not sonner" },
    schema: [],
    messages: {
      directSonnerImport:
        "Import toast from the app's wrapper rather than from sonner — the wrapper is what makes every toast carry a severity and deduplicate by content.",
    },
  },
  defaultOptions: [],
  create(context) {
    return moduleSourceVisitors((node, source) => {
      if (source.value !== "sonner") return;
      context.report({ node, messageId: "directSonnerImport" });
    });
  },
});
