// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Context, Hono } from "hono";
import { z } from "zod";
import { creditGrantWriteSchema } from "@breatic/core";
import { validate } from "@server/middleware/validate.js";
import { creditGrantService } from "@server/modules/index.js";
import { fingerprint } from "@server/modules/credit-refund/idempotency.js";

const ACCOUNT = "/internal/v1/accounts/:userId/credit-grants";
const OPERATION = "/internal/v1/credit-grant-operations/:key";
const uuid = z.string().uuid();
const requestKey = z.string().regex(/^bo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** Translate the finite service response to the internal HTTP protocol. */
function send(c: Context, answer: creditGrantService.GrantAnswer<unknown>): Response {
  return c.json(answer.body as object, answer.status);
}

/** Register the three signed endpoints exclusively on the internal listener. */
export function registerCreditGrantRoutes(app: Hono): void {
  app.get(`${ACCOUNT}/profile`, validate("param", z.object({ userId: uuid })), async (c) => send(c, await creditGrantService.profile(c.req.valid("param").userId)));
  app.get(OPERATION, validate("param", z.object({ key: requestKey })), async (c) => send(c, await creditGrantService.operation(c.req.valid("param").key)));
  app.post(ACCOUNT, validate("param", z.object({ userId: uuid })), validate("json", creditGrantWriteSchema), async (c) => {
    const key = c.req.header("idempotency-key");
    if (!requestKey.safeParse(key).success) return c.json({ code: "invalid_body" }, 422);
    const userId = c.req.valid("param").userId;
    const body = c.req.valid("json");
    const adminId = c.get("internalAdmin");
    c.set("internalReason", body.reason);
    return send(c, await creditGrantService.grant({ userId, key: key!, adminId, body,
      hash: fingerprint("POST", ACCOUNT, userId, { adminId, body }),
    }));
  });
}
