// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The account's referral routes (inner#1868 §7, §8): the membership panel's
 * two sections read here, a code is bound later here, and promoter
 * applications are filed here. All answer 404 while payments are off.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { storableText } from "@server/utils/storable-text.js";
import {
  PROMOTER_CHANNEL_INPUT_MAX,
  PROMOTER_CHANNELS_MAX,
  PROMOTER_PLAN_INPUT_MAX,
  REFERRAL_CODE_INPUT_MAX,
  t,
} from "@breatic/shared";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { requirePayments } from "@server/middleware/require-payments.js";
import { runOnce } from "@server/middleware/run-once.js";
import { validate } from "@server/middleware/validate.js";
import { getLegalConfig } from "@server/config/legal.js";
import { submitApplication } from "@server/modules/referral/promoter-application.service.js";
import { bindLater, readAccountReferral } from "@server/modules/referral/referral.service.js";
import { idempotencyKeyHeaderSchema } from "@server/routes/schemas.js";

const referral = new Hono<{ Variables: AuthVariables }>();

referral.use(requireAuth);
referral.use(requirePayments);

const bindingBody = z.object({ code: z.string().min(1).max(REFERRAL_CODE_INPUT_MAX) });
const applicationBody = z.object({
  country: z.string().regex(/^[A-Z]{2}$/),
  channels: z.array(storableText(z.string().trim().min(1).max(PROMOTER_CHANNEL_INPUT_MAX))).min(1).max(PROMOTER_CHANNELS_MAX),
  plan: storableText(z.string().trim().min(1).max(PROMOTER_PLAN_INPUT_MAX)),
  termsVersion: z.string().min(1).max(32),
});

/**
 * Answers a business refusal the browser can tell apart by `reason`.
 * @param c - The request context.
 * @param status - 409 or 422.
 * @param reason - The refusal code.
 * @param extra - Further fields the browser needs.
 * @returns The response.
 */
function refuse(c: Context, status: 409 | 422, reason: string, extra: Record<string, unknown> = {}): Response {
  return c.json({ error: { code: status, message: t(`server.referral.${reason}`), reason, ...extra } }, status);
}

/** `GET /account/referral` — what the membership panel's referral sections show. */
referral.get("/", rateLimitFor("referral-read", "user"), async (c) => {
  const userId = c.get("user").id;
  return c.json({ data: await readAccountReferral(userId, getLegalConfig().promoter_terms_version) });
});

/** `POST /account/referral/binding` — attach a code before the first membership payment. */
referral.post(
  "/binding",
  rateLimitFor("referral-bind", "user"),
  validate("header", idempotencyKeyHeaderSchema),
  validate("json", bindingBody),
  runOnce("referral"),
  async (c) => {
    const userId = c.get("user").id;
    const outcome = await bindLater(userId, c.req.valid("json").code);
    if (!outcome.ok) return refuse(c, 422, outcome.reason);
    return c.json({ data: await readAccountReferral(userId, getLegalConfig().promoter_terms_version) });
  },
);

/** `POST /account/referral/applications` — apply to become a promoter. */
referral.post(
  "/applications",
  rateLimitFor("promoter-apply", "user"),
  validate("header", idempotencyKeyHeaderSchema),
  validate("json", applicationBody),
  runOnce("referral"),
  async (c) => {
    const userId = c.get("user").id;
    const terms = getLegalConfig().promoter_terms_version;
    const outcome = await submitApplication(userId, c.req.valid("json"), terms);
    if (!outcome.ok) {
      return outcome.reason === "terms_changed"
        ? refuse(c, 409, outcome.reason, { termsVersion: outcome.termsVersion })
        : refuse(c, 409, outcome.reason);
    }
    return c.json({ data: await readAccountReferral(userId, terms) });
  },
);

export { referral as referralRoute };
