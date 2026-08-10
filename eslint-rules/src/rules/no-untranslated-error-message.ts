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
 * `ConflictLockedError` is absent from the class list because a caller passes
 * it a structured `detail` and no message at all. That covers the caller and
 * not the class: the message is written once, inside its own constructor, as
 * `super(409, …)`. So the rule reads `super()` too — a subclass of this family
 * hardcoding its message there is the same defect one level down, and it
 * shipped exactly that way until Gate 2 found it.
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
          report(node.callee.name, node.arguments);
        },

        // `super(status, message)` inside a subclass of this family.
        "CallExpression[callee.type='Super']"(node: TSESTree.CallExpression): void {
          // A subclass reaching `super` with a status first is the AppError
          // shape; the message is the second argument, as it is for AppError.
          report("AppError", node.arguments);
        },
      };

      /**
       * Report the message argument when it is written inline.
       * @param name - Constructor being called, which decides the argument index.
       * @param args - The call's arguments.
       */
      function report(
        name: string,
        args: TSESTree.CallExpressionArgument[],
      ): void {
          if (!APP_ERRORS.has(name)) return;

          const arg = args[MESSAGE_INDEX[name] ?? 0];
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
      }
    },
  },
);
