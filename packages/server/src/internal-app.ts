// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The internal API (inner#1410 §4): a second Hono app on its own port, for
 * the back office alone. Nothing here is mounted on the public app.
 *
 * Every request passes, in order: one log line for it, the rate limit by
 * connection address (fail closed), the body size limit, the signature and
 * nonce, then the authorisation table; whatever the table does not list is
 * 403.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { logger } from "@breatic/core";
import { internalAuth } from "@server/middleware/internal-auth.js";
import { internalErrorHandler } from "@server/middleware/internal-errors.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { registerInternalRoutes } from "@server/routes/internal/index.js";

/** The largest legitimate body is about 26 KiB (§4.6). */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * One structured line per request, refused ones included (acceptance #14).
 * Registered first, so it sees the status every later step answered with.
 * @param c - The request context.
 * @param next - The rest of the app.
 */
const logRequest: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  await next();
  logger.info(
    {
      adminId: c.get("internalAdmin"),
      method: c.req.method,
      path: c.req.path,
      idempotencyKey: c.req.header("idempotency-key"),
      status: c.res.status,
      durationMs: Date.now() - start,
    },
    "internal_api_request",
  );
};

/**
 * Build the internal app.
 * @returns The app, ready for `serve`.
 */
export function createInternalApp(): Hono {
  const app = new Hono();
  app.onError(internalErrorHandler);
  app.notFound((c) => c.json({ code: "forbidden" }, 403));
  app.use("*", logRequest);
  app.use(
    "*",
    rateLimitFor("internal-api", "socket", {
      onLimited: (c) => c.json({ code: "rate_limited" }, 429),
      failClosed: (c) => c.json({ code: "unavailable" }, 503),
    }),
  );
  app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ code: "invalid_body" }, 413) }));
  app.use("*", internalAuth());
  registerInternalRoutes(app);
  return app;
}
