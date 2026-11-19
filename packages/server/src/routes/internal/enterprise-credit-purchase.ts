// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Context, Hono } from "hono";
import { z } from "zod";
import { creditGrantKeySchema, enterpriseCreditPurchaseWriteSchema } from "@breatic/core";
import { validate } from "@server/middleware/validate.js";
import { enterpriseCreditPurchaseService } from "@server/modules/index.js";
import { fingerprint } from "@server/modules/credit-refund/idempotency.js";

const ACCOUNT = "/internal/v1/accounts/:userId/enterprise-credit-purchases";
const OPERATION = "/internal/v1/enterprise-credit-purchase-operations/:key";

/**
 * Return the finite internal enterprise-purchase protocol.
 * @param c - The authenticated internal context.
 * @param answer - The service's validated response.
 * @returns The internal HTTP result.
 */
function send(c: Context, answer: enterpriseCreditPurchaseService.EnterpriseCreditPurchaseAnswer<unknown>): Response {
  return c.json(answer.body as object, answer.status);
}

/**
 * Register enterprise purchase endpoints on the signed internal listener.
 * @param app - The authenticated internal listener.
 */
export function registerEnterpriseCreditPurchaseRoutes(app: Hono): void {
  app.get(`${ACCOUNT}/profile`, validate("param", z.object({ userId: z.string().uuid() })), async c => send(c, await enterpriseCreditPurchaseService.profile(c.req.valid("param").userId)));
  app.get(OPERATION, validate("param", z.object({ key: creditGrantKeySchema })), async c => send(c, await enterpriseCreditPurchaseService.operation(c.req.valid("param").key)));
  app.post(ACCOUNT, validate("param", z.object({ userId: z.string().uuid() })), validate("json", enterpriseCreditPurchaseWriteSchema), async c => {
    const key = c.req.header("idempotency-key");
    if (!creditGrantKeySchema.safeParse(key).success) return c.json({ code: "invalid_body" }, 422);
    const userId = c.req.valid("param").userId;
    const body = c.req.valid("json");
    const adminId = c.get("internalAdmin");
    c.set("internalReason", body.reason);
    return send(c, await enterpriseCreditPurchaseService.purchase({ userId, key: key!, adminId, body, hash: fingerprint("POST", ACCOUNT, userId, { adminId, body }) }));
  });
}
