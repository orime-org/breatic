// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The internal API's request authentication (inner#1410 §4.2): the signature
 * checks in `internal-signature.ts`, then the nonce, which needs Redis. Any
 * failed step is 401 `{ code: "unauthorized" }`; Redis unavailable is 503,
 * never let through.
 */

import type { MiddlewareHandler } from "hono";
import { env, getRedis, logger } from "@breatic/core";
import { WINDOW_SECONDS, verifyInternalRequest } from "@server/middleware/internal-signature.js";

/**
 * How long a nonce is remembered. The window compares whole seconds and
 * includes both ends, so a timestamp `ts` is accepted from `ts - 300` until
 * just before `ts + 301` (the floor adds that last second); counting from the
 * first acceptance, that is at most 601 seconds, kept one more for margin.
 */
const NONCE_TTL_SECONDS = 2 * WINDOW_SECONDS + 2;

declare module "hono" {
  interface ContextVariableMap {
    /** The back office admin an internal API request acts for. */
    internalAdmin: string;
    /** The operator's reason a write request gave, for its log line. */
    internalReason: string;
  }
}

/**
 * Refuse any request that is not signed by the back office, or that repeats
 * a nonce. Sets `internalAdmin` for the handlers.
 * @returns The middleware.
 */
export function internalAuth(): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const verdict = verifyInternalRequest(
      {
        method: c.req.method,
        pathWithQuery: `${url.pathname}${url.search}`,
        headers: {
          "x-internal-admin": c.req.header("x-internal-admin"),
          "x-internal-timestamp": c.req.header("x-internal-timestamp"),
          "x-internal-nonce": c.req.header("x-internal-nonce"),
          "x-internal-signature": c.req.header("x-internal-signature"),
          "idempotency-key": c.req.header("idempotency-key"),
        },
        body: await c.req.text(),
      },
      { current: env.INTERNAL_API_SECRET, previous: env.INTERNAL_API_SECRET_PREVIOUS },
      Math.floor(Date.now() / 1000),
    );
    if (!verdict.ok) {
      logger.warn({ step: verdict.step, path: c.req.path }, "internal_auth_rejected");
      return c.json({ code: "unauthorized" }, 401);
    }
    let fresh: string | null;
    try {
      fresh = await getRedis().set(
        `${env.ENV}:server:internal-nonce:${verdict.nonce}`,
        "1",
        "EX",
        NONCE_TTL_SECONDS,
        "NX",
      );
    } catch (err) {
      logger.error({ err }, "internal_nonce_unavailable");
      return c.json({ code: "unavailable" }, 503);
    }
    if (fresh === null) {
      logger.warn({ step: "nonce", path: c.req.path }, "internal_auth_rejected");
      return c.json({ code: "unauthorized" }, 401);
    }
    c.set("internalAdmin", verdict.adminId);
    await next();
  };
}
