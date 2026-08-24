// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
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
 * What it matches, exactly: a call whose receiver is a member expression
 * named `req` — `c.req.json()`, `ctx.req.parseBody()`. The context parameter
 * can be named anything; the access chain cannot.
 *
 * What it does NOT match, measured with the rule itself rather than reasoned
 * about (2026-08-10):
 *
 *   c.req.raw.json()          the receiver's property is `raw`, not `req`
 *   const { req } = c         the receiver is a plain identifier
 *   const r = c.req           likewise
 *   JSON.parse(await c.req.text())   not a body-reading call at all
 *
 * So it closes the shape that shipped and nothing wider. It is not a proof
 * that every body is validated — no single-file check can see whether a
 * given handler's route mounted `validate`, and the exit answers 500 with a
 * log for anything that gets past here, which is the correct outcome for a
 * guard that was circumvented. Widening the matcher to the chains above is
 * filed separately rather than done here.
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

        // Match on `<anything>.req.<method>()` rather than on a context named
        // `c`: the parameter name is the handler author's choice, and a rule
        // keyed on it would pass a file that renamed it.
        const receiver = callee.object;
        if (receiver.type !== "MemberExpression" || receiver.computed) return;
        if (receiver.property.type !== "Identifier") return;
        if (receiver.property.name !== "req") return;

        context.report({ node, messageId: "rawBodyParse", data: { method } });
      },
    };
  },
});
