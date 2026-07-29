// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/**
 * Library packages must not read environment variables.
 *
 * Acquiring configuration is an application decision, the same boundary that
 * keeps loggers and `process.exit` out of libraries. Each service entry is
 * the composition root: it loads dotenv and calls `initCore(process.env)`
 * once, a zod schema validates the result, and libraries read what was
 * injected through the `env` proxy, `getConfig()` or `getRawEnvVar()`.
 *
 * `process.cwd()` is untouched — it is not configuration.
 */
export const noLibraryEnvAccess = createRule({
  name: "no-library-env-access",
  meta: {
    type: "problem",
    docs: {
      description:
        "Library packages must take configuration through initCore rather than reading process.env",
    },
    schema: [],
    messages: {
      noProcessEnv:
        "Library packages must not read process.env — take configuration through initCore/env instead. The application entry owns configuration acquisition.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      [[
        "MemberExpression[computed=false][object.name='process'][property.name='env']",
        "MemberExpression[computed=true][object.name='process'][property.value='env']",
      ].join(", ")](node: TSESTree.MemberExpression): void {
        context.report({ node, messageId: "noProcessEnv" });
      },
    };
  },
});
