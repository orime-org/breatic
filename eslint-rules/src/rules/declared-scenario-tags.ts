// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";
import { SCENARIO_TAG_PREFIX, isScenarioTag } from "#rules/scenario-tags";
import { stringLiteralVisitors } from "#rules/source-visitors";

/**
 * Finds every scenario-shaped tag in a piece of text.
 *
 * A tag starts at a word boundary so `cases@needs-model-review` inside a
 * sentence is prose rather than a tag, and runs to the end of the word.
 */
const SCENARIO_SHAPED = new RegExp(
  `(?<![\\w-])${SCENARIO_TAG_PREFIX}[\\w-]+`,
  "g",
);

/**
 * A scenario tag is one of the declared ones.
 *
 * A misspelt tag is worse than no tag. The tag is what keeps a case out of
 * the default selection, and the exclusion works by matching the prefix
 * against a list — a tag nobody declared matches nothing, so the case reads
 * as guarded to whoever wrote it and runs on a clean machine anyway. It
 * then fails for want of a service, and the failure points at the product.
 *
 * Inventing a tag is also how the list quietly grows a second name for one
 * service. Going through the declared list means adding a service is a
 * decision somebody makes once, in the place all three readers of that list
 * share.
 */
export const declaredScenarioTags = createRule<[], "undeclaredTag">({
  name: "declared-scenario-tags",
  meta: {
    type: "problem",
    docs: {
      description: "A scenario tag comes from the declared list",
    },
    schema: [],
    messages: {
      undeclaredTag:
        "'{{tag}}' is not a declared scenario tag, so nothing excludes this case from the default run. Use one of the declared tags, or add the service to the list.",
    },
  },
  defaultOptions: [],
  create(context) {
    /**
     * Reports every scenario-shaped tag in the text that is not declared.
     * @param node Node to report on.
     * @param text The string to search.
     */
    function check(node: TSESTree.Node, text: string): void {
      for (const found of text.matchAll(SCENARIO_SHAPED)) {
        const tag = found[0];
        if (isScenarioTag(tag)) continue;
        context.report({ node, messageId: "undeclaredTag", data: { tag } });
      }
    }

    return stringLiteralVisitors(check);
  },
});
