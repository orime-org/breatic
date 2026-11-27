// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { Context, Hono } from "hono";
import { z } from "zod";
import { validate, fingerprint } from "@breatic/core";
import { influencerService } from "@server/modules/index.js";

const CREATE = "/internal/v1/influencers";
const STATUS = "/internal/v1/influencers/:code/status";
const OPERATION = "/internal/v1/influencer-operations/:key";
const code = z.string().regex(/^[a-z0-9-]{1,32}$/);
const requestKey = z.string().regex(/^bo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const openSchema = z.object({ code, host: z.string().min(1).max(253) }).strict();
const statusSchema = z.object({ enabled: z.boolean() }).strict();

/**
 * Translate the finite service answer to the internal HTTP protocol.
 * @param c - The authenticated internal HTTP context.
 * @param answer - The service answer.
 * @returns The internal HTTP response.
 */
function send(c: Context, answer: influencerService.InfluencerAnswer): Response {
  return c.json(answer.body as object, answer.status);
}

/**
 * The idempotency key of a write, or null when it is missing or malformed.
 * @param c - The internal HTTP context.
 * @returns The key.
 */
function keyOf(c: Context): string | null {
  const key = c.req.header("idempotency-key");
  return requestKey.safeParse(key).success ? key! : null;
}

/**
 * Register the influencer endpoints on the internal listener (inner#2157 design 7.6).
 * @param app - The authenticated internal listener.
 */
export function registerInfluencerRoutes(app: Hono): void {
  app.get(OPERATION, validate("param", z.object({ key: requestKey })), async (c) =>
    send(c, await influencerService.operation(c.req.valid("param").key)));
  app.post(CREATE, validate("json", openSchema), async (c) => {
    const key = keyOf(c);
    if (key === null) return c.json({ code: "invalid_body" }, 422);
    const body = c.req.valid("json");
    const adminId = c.get("internalAdmin");
    return send(c, await influencerService.open({ key, adminId, hash: fingerprint("POST", CREATE, "", { adminId, body }) }, body));
  });
  app.post(STATUS, validate("param", z.object({ code })), validate("json", statusSchema), async (c) => {
    const key = keyOf(c);
    if (key === null) return c.json({ code: "invalid_body" }, 422);
    const target = c.req.valid("param").code;
    const { enabled } = c.req.valid("json");
    const adminId = c.get("internalAdmin");
    return send(c, await influencerService.setStatus(
      { key, adminId, hash: fingerprint("POST", STATUS, target, { adminId, body: { enabled } }) }, target, enabled,
    ));
  });
}
