// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The endpoints the billing service calls on the product (inner#1993 §3.3),
 * reachable only by the `commerce` signer (`signerMayAccess`). Each handler
 * checks the path and body and hands them to its service; the service's
 * stored answer is sent as it is.
 */

import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  REFUND_STEPS,
  accountLookupRequestSchema,
  conversionReportSchema,
  paymentGrantRequestSchema,
  refundLotFactsRequestSchema,
  refundStepRequestSchema,
  subscriptionFactRequestSchema,
  validate,
} from "@breatic/core";
import { lookupAccounts, readAccount } from "@server/modules/commerce/commerce-accounts.service.js";
import { reportConversion } from "@server/modules/commerce/commerce-conversions.service.js";
import { readRefundLotFacts } from "@server/modules/commerce/commerce-refund-lots.service.js";
import { applyRefundStep } from "@server/modules/commerce/commerce-refund-steps.service.js";
import { applySubscriptionFact } from "@server/modules/commerce/commerce-subscription-facts.service.js";
import { grantPayment } from "@server/modules/commerce/payment-grant.service.js";

const BASE = "/internal/v1/commerce";
const uuid = z.string().uuid();

/**
 * Send a stored answer.
 * @param c - The context.
 * @param answer - The service's stored answer.
 * @param answer.httpStatus - Its status.
 * @param answer.body - Its body.
 * @returns The response.
 */
function send(c: Context, answer: { httpStatus: number; body: unknown }): Response {
  return c.json(answer.body as object, answer.httpStatus as 200);
}

/**
 * Register the billing service's endpoints on the internal app.
 * @param app - The internal app, after its rate limit and authentication.
 */
export function registerCommerceRoutes(app: Hono): void {
  app.put(
    `${BASE}/subscription-facts/:deliveryId`,
    validate("param", z.object({ deliveryId: uuid })),
    validate("json", subscriptionFactRequestSchema),
    async (c) => send(c, await applySubscriptionFact(c.req.valid("param").deliveryId, c.req.valid("json"))),
  );
  app.post(
    `${BASE}/payment-grants/:paymentId`,
    validate("param", z.object({ paymentId: uuid })),
    validate("json", paymentGrantRequestSchema),
    async (c) => send(c, await grantPayment(c.req.valid("param").paymentId, c.req.valid("json"))),
  );
  app.post(
    `${BASE}/refund-steps/:operationId/:step`,
    validate("param", z.object({ operationId: uuid, step: z.enum(REFUND_STEPS) })),
    validate("json", refundStepRequestSchema),
    async (c) => {
      const { operationId, step } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.step !== step) return c.json({ code: "invalid_body" }, 422);
      return send(c, await applyRefundStep(operationId, step, body));
    },
  );
  app.post(`${BASE}/refund-lots/facts`, validate("json", refundLotFactsRequestSchema), async (c) =>
    send(c, await readRefundLotFacts(c.req.valid("json").lotIds)),
  );
  app.post(`${BASE}/accounts/lookup`, validate("json", accountLookupRequestSchema), async (c) =>
    send(c, await lookupAccounts(c.req.valid("json").userIds)),
  );
  app.get(`${BASE}/accounts/:userId`, validate("param", z.object({ userId: uuid })), async (c) =>
    send(c, await readAccount(c.req.valid("param").userId)),
  );
  app.post(`${BASE}/conversions`, validate("json", conversionReportSchema), async (c) =>
    send(c, await reportConversion(c.req.valid("json"))),
  );
}
