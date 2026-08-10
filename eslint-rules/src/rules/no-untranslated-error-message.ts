// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** The error family whose message reaches a client through `errorHandler`. */
const APP_ERRORS = new Set([
  "AppError",
  "ValidationError",
  "NotFoundError",
  "ForbiddenError",
  "ConflictError",
  "UnauthorizedError",
]);

/**
 * `AppError` takes the status first and the message second; every subclass
 * takes the message first.
 */
const MESSAGE_INDEX: Readonly<Record<string, number>> = { AppError: 1 };

/**
 * The message a client reads is built with `t()`, never written inline.
 *
 * `errorHandler` puts an `AppError`'s message on the wire verbatim — that is
 * the thrower's sentence, not the handler's — so a literal written here is a
 * literal the user reads. In a product that ships five languages, a user who
 * picked Japanese then reads an English sentence, and the language they chose
 * stops meaning anything at the first failure that matters.
 *
 * This is what a check can see: whether the message argument is a call to
 * `t`. It cannot see whether the key exists or reads well in every catalog —
 * `i18n-no-missing-keys` covers the first, and nothing covers the second.
 *
 * `ConflictLockedError` is absent from the list on purpose: its constructor
 * takes a structured `detail` and builds its own message, so a caller has no
 * message argument to get wrong.
 */
export const noUntranslatedErrorMessage = createRule<[], "untranslatedMessage">(
  {
    name: "no-untranslated-error-message",
    meta: {
      type: "problem",
      docs: {
        description: "A client-facing error message is built with t(), not written inline",
      },
      schema: [],
      messages: {
        untranslatedMessage:
          "This message goes to the client exactly as written, so an English literal is what a user reads whatever language they picked. Build it with `t(\"server.…\")` and add the key to all five catalogs in locales/.",
      },
    },
    defaultOptions: [],
    create(context) {
      return {
        NewExpression(node: TSESTree.NewExpression): void {
          if (node.callee.type !== "Identifier") return;
          const name = node.callee.name;
          if (!APP_ERRORS.has(name)) return;

          const arg = node.arguments[MESSAGE_INDEX[name] ?? 0];
          if (arg === undefined) return;

          // A `t(...)` call is the shape we want. Anything spread, or built
          // from a variable, is out of a single file's sight — report only
          // what is plainly a literal written here.
          const isLiteral =
            arg.type === "Literal" ||
            arg.type === "TemplateLiteral" ||
            (arg.type === "BinaryExpression" && arg.operator === "+");
          if (!isLiteral) return;

          context.report({ node: arg, messageId: "untranslatedMessage" });
        },
      };
    },
  },
);
