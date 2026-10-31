// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
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
 * `AppError` takes the status first and the message second; each subclass in
 * {@link APP_ERRORS} takes the message first. `ConflictLockedError` follows
 * neither — it takes a structured detail and writes its own message — which is
 * why it is absent from that list and reached through `super()` instead.
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
 * This is what a check can see: whether the message argument is written out
 * here as a literal — a string, a template, or a `+` chain of them. It reports
 * those and nothing else, so any call passes, `t()` among them; a message
 * assembled elsewhere is out of one file's sight and is left alone. It also
 * cannot see whether a key exists or reads well in every catalog —
 * `i18n-no-missing-keys` covers the first, and nothing covers the second.
 *
 * `ConflictLockedError` is absent from the class list because a caller passes
 * it a structured `detail` and no message at all. That covers the caller and
 * not the class: the message is written once, inside its own constructor, as
 * `super(409, …)`. So the rule reads `super()` too, and it shipped a hardcoded
 * English message there until Gate 2 found it.
 *
 * A `super()` call is read as a call to the class named in the enclosing
 * class's `extends` clause, so `AppError` subclasses are read at their second
 * argument and subclasses of the message-first errors at their first. A class
 * that extends anything outside the family, or an expression rather than a
 * name, is not read: a family member reached through another file's class is
 * out of one file's sight.
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

        "CallExpression[callee.type='Super']"(node: TSESTree.CallExpression): void {
          const parent = extendedClassName(node);
          if (parent !== null) report(parent, node.arguments);
        },
      };

      /**
       * Name of the class the `super()` call's enclosing class extends.
       * @param node - The `super()` call.
       * @returns The extended class's name, or null when it is not a plain name.
       */
      function extendedClassName(node: TSESTree.Node): string | null {
        let current: TSESTree.Node | undefined = node.parent;
        while (
          current !== undefined &&
          current.type !== "ClassDeclaration" &&
          current.type !== "ClassExpression"
        ) {
          current = current.parent;
        }
        const superClass = current?.superClass;
        return superClass?.type === "Identifier" ? superClass.name : null;
      }

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
