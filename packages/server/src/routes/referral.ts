// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The account's referral routes (inner#1993 §3.2): the billing service holds
 * referral codes, bindings and promoter applications; these keep the web
 * paths, auth, rate limits and body checks and hand each request to the
 * user's endpoint there. All answer 404 where nothing is sold.
 */

import { Hono } from "hono";
import { promoterApplicationBodySchema, referralBindingBodySchema, validate } from "@breatic/core";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { requireSelling } from "@server/middleware/require-selling.js";
import { runOnce } from "@server/middleware/run-once.js";
import { userPath } from "@server/modules/commerce/commerce-client.js";
import { sendPendingReferralBinding } from "@server/modules/commerce/commerce-relay.js";
import { idempotencyKeyHeaderSchema } from "@server/routes/schemas.js";
import { forwardToCommerce, idempotencyKeyOf } from "@server/routes/commerce-forward.js";

const referral = new Hono<{ Variables: AuthVariables }>();

referral.use(requireAuth);
referral.use(requireSelling);

/** `GET /account/referral` — what the membership panel's referral sections show. */
referral.get("/", rateLimitFor("referral-read", "user"), async (c) =>
  forwardToCommerce(c, { method: "GET", path: userPath(c.get("user").id, "/referral"), quick: true }),
);

/**
 * `POST /account/referral/binding` — attach a code before the first
 * membership payment. The code the account signed up with is decided first:
 * this request sends it to the billing service if it is still pending.
 */
referral.post(
  "/binding",
  rateLimitFor("referral-bind", "user"),
  validate("header", idempotencyKeyHeaderSchema),
  validate("json", referralBindingBodySchema),
  runOnce("referral"),
  async (c) => {
    const userId = c.get("user").id;
    await sendPendingReferralBinding(userId);
    return forwardToCommerce(c, {
      method: "POST",
      path: userPath(userId, "/referral/binding"),
      body: c.req.valid("json"),
      ...idempotencyKeyOf(c.req.valid("header")),
    });
  },
);

/** `POST /account/referral/applications` — apply to become a promoter. */
referral.post(
  "/applications",
  rateLimitFor("promoter-apply", "user"),
  validate("header", idempotencyKeyHeaderSchema),
  validate("json", promoterApplicationBodySchema),
  runOnce("referral"),
  async (c) =>
    forwardToCommerce(c, {
      method: "POST",
      path: userPath(c.get("user").id, "/referral/applications"),
      body: c.req.valid("json"),
      ...idempotencyKeyOf(c.req.valid("header")),
    }),
);

export { referral as referralRoute };
