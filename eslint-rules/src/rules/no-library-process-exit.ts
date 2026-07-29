// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/**
 * Library packages must not end the process.
 *
 * A library knows something went wrong but not whether the process should
 * die: exiting `server` means a permanent 503, exiting `worker` cuts the
 * BullMQ retry chain, exiting `collab` drops every live editing session.
 * Only the application entry owns that decision, so libraries throw a typed
 * error and let the entry catch, log the context, and exit.
 *
 * Known boundary: reaching the same primitive through a destructured binding
 * (`const { exit } = process`) or through `globalThis` is not flagged. Both
 * require deliberate effort to write, and a guard that tries to enumerate
 * every evasion never converges — this one covers the ways the call is
 * actually written.
 */
export const noLibraryProcessExit = createRule({
  name: "no-library-process-exit",
  meta: {
    type: "problem",
    docs: {
      description:
        "Library packages must throw a typed error instead of ending the process",
    },
    schema: [],
    messages: {
      noProcessExit:
        "Library packages must not call process.exit — throw a typed error and let the application entry decide whether to exit.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      [[
        "MemberExpression[computed=false][object.name='process'][property.name='exit']",
        "MemberExpression[computed=true][object.name='process'][property.value='exit']",
      ].join(", ")](node: TSESTree.MemberExpression): void {
        context.report({ node, messageId: "noProcessExit" });
      },
    };
  },
});
