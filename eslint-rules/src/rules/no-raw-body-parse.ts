// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { ASTUtils, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/**
 * Request methods that hand back a parsed, structured body.
 *
 * Their results are the shape a schema exists to check, so reading one
 * directly means the check either did not happen or happened by hand.
 * `text()`, `arrayBuffer()` and `raw.body` are deliberately absent: they
 * return the bytes as sent, which is the only correct input for a webhook
 * signature (`payment.ts` verifies Stripe's over the raw body) or a bounded
 * stream read.
 */
const PARSED_BODY_READERS = new Set(["json", "parseBody", "formData"]);

/**
 * Routes must not parse a request body themselves.
 *
 * Three routes in `studios.ts` did — `schema.parse(await c.req.json())` —
 * and each was a 500 for a request the caller simply got wrong: a bare
 * `ZodError` is not an `AppError`, so it fell past the error handler's typed
 * branches into the one that answers 500 and logs `Unhandled error`. A
 * truncated body was worse: `c.req.json()` throws a native `SyntaxError`,
 * which nothing recognised either.
 *
 * A guard on the `zValidator` import would not have caught any of it. That
 * import was already in the file, used two lines away — the defect was never
 * a wrong import, it was a route going around the library entirely. So this
 * reads the call instead, which is exactly the thing that went wrong and is
 * visible in one file with nothing standing in for it.
 *
 * What it matches: a parsing call on the request or on its underlying
 * `Request` — `c.req.json()`, `ctx.req.parseBody()`, `c.req.raw.json()` — and
 * on a variable declared from either, by destructuring (`const { req } = c`)
 * or by assignment (`const r = c.req`). The context parameter can be named
 * anything; the access chain decides.
 *
 * What it does not match: a parameter that is merely named `req`, a value
 * passed in from another file, and `JSON.parse(await c.req.text())`, which is
 * not a body-parsing call. It is not a proof that every body is validated —
 * no single-file check can see whether a given handler's route mounted
 * `validate`, and the exit answers 500 with a log for anything that gets past
 * here, which is the correct outcome for a guard that was circumvented.
 */
export const noRawBodyParse = createRule<[], "rawBodyParse">({
  name: "no-raw-body-parse",
  meta: {
    type: "problem",
    docs: {
      description: "Routes validate through `validate`, never by parsing the body themselves",
    },
    schema: [],
    messages: {
      rawBodyParse:
        "Do not read the request body with `req.{{method}}()` — mount `validate(target, schema)` from @server/middleware/validate and read `c.req.valid(target)`. Parsing here means a rejection escapes as a bare ZodError (500 + `Unhandled error`) instead of our localised envelope. Raw bytes for a signature check are a different need: `req.text()` is allowed.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression): void {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        if (callee.property.type !== "Identifier") return;
        const method = callee.property.name;
        if (!PARSED_BODY_READERS.has(method)) return;

        if (requestKind(callee.object) === null) return;

        context.report({ node, messageId: "rawBodyParse", data: { method } });
      },
    };

    /**
     * What request object an expression holds, following variable aliases.
     *
     * `req` is a `<anything>.req` member, `raw` is that request's underlying
     * `Request` (`.raw`). The context parameter's name is the handler author's
     * choice, so a member is matched by its property, never by its object.
     * @param expr - The receiver of a call.
     * @returns `req`, `raw`, or null when it is neither.
     */
    function requestKind(expr: TSESTree.Node): "req" | "raw" | null {
      if (expr.type === "MemberExpression" && !expr.computed) {
        if (expr.property.type !== "Identifier") return null;
        if (expr.property.name === "req") return "req";
        if (expr.property.name === "raw" && requestKind(expr.object) === "req") return "raw";
        return null;
      }
      if (expr.type !== "Identifier") return null;

      const variable = ASTUtils.findVariable(context.sourceCode.getScope(expr), expr);
      const declarator = variable?.defs[0]?.node;
      if (declarator?.type !== "VariableDeclarator") return null;
      if (declarator.id.type === "Identifier") {
        return declarator.init === null ? null : requestKind(declarator.init);
      }
      if (declarator.id.type !== "ObjectPattern") return null;
      for (const property of declarator.id.properties) {
        if (property.type !== "Property" || property.computed) continue;
        if (property.value.type !== "Identifier" || property.value.name !== expr.name) continue;
        if (property.key.type !== "Identifier") return null;
        if (property.key.name === "req") return "req";
        if (property.key.name === "raw" && declarator.init !== null) {
          return requestKind(declarator.init) === "req" ? "raw" : null;
        }
        return null;
      }
      return null;
    }

  },
});
