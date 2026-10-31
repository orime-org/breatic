// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Context, Hono } from "hono";
import { z } from "zod";
import { enterpriseMembershipWriteSchema } from "@breatic/core";
import type { EnterpriseMembershipWrite } from "@breatic/core";
import { validate } from "@server/middleware/validate.js";
import { enterpriseMembershipService } from "@server/modules/index.js";
import { fingerprint } from "@server/modules/credit-refund/idempotency.js";

const ACCOUNT = "/internal/v1/accounts/:userId/enterprise-membership";
const OPERATION = "/internal/v1/enterprise-membership-operations/:key";
const uuid = z.string().uuid();
const requestKey = z.string().regex(/^bo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/**
 * Translate the service's finite status into the internal HTTP response.
 * @param c - The authenticated request context.
 * @param answer - Its typed service answer.
 * @returns The HTTP response.
 */
function send(c: Context, answer: enterpriseMembershipService.MembershipAnswer<unknown>): Response {
  return c.json(answer.body as object, answer.status);
}

/**
 * Register membership management only on the signed internal listener.
 * @param app - The internal app after authentication and rate limiting.
 */
export function registerEnterpriseMembershipRoutes(app: Hono): void {
  app.get(ACCOUNT, validate("param", z.object({ userId: uuid })), async (c) => send(c, await enterpriseMembershipService.profile(c.req.valid("param").userId)));
  app.get(OPERATION, validate("param", z.object({ key: requestKey })), async (c) => send(c, await enterpriseMembershipService.operation(c.req.valid("param").key)));
  app.post(ACCOUNT, validate("param", z.object({ userId: uuid })), validate("json", enterpriseMembershipWriteSchema), async (c) => {
    const key = c.req.header("idempotency-key");
    if (!requestKey.safeParse(key).success) return c.json({ code: "invalid_body" }, 422);
    const userId = c.req.valid("param").userId;
    const body: EnterpriseMembershipWrite = c.req.valid("json");
    return send(c, await enterpriseMembershipService.save({
      userId,
      key: key!,
      hash: fingerprint("POST", ACCOUNT, userId, body),
      adminId: c.get("internalAdmin"),
      body,
    }));
  });
}
