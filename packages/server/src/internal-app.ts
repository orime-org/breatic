// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The internal API (inner#1410 §4): a second Hono app on its own port, for
 * the back office alone. Nothing here is mounted on the public app.
 *
 * Every request passes, in order: one log line for it, the rate limit by
 * connection address (fail closed), the body size limit, the signature and
 * nonce, a 403 for HEAD, then the authorisation table; whatever the table
 * does not list is 403.
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
      reason: c.get("internalReason"),
      status: c.res.status,
      code: c.res.status >= 400 ? await answerCode(c.res) : undefined,
      durationMs: Date.now() - start,
    },
    "internal_api_request",
  );
};

/**
 * The `code` of a refusal's JSON body.
 * @param res - The response.
 * @returns The code, or undefined when the body carries none.
 */
async function answerCode(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.clone().json();
    return typeof body === "object" && body !== null && "code" in body ? String(body.code) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * HEAD is answered by the GET route in Hono, which the authorisation table
 * does not list for it: refuse it like any other undeclared method.
 * @param c - The request context.
 * @param next - The rest of the app.
 * @returns 403 for HEAD.
 */
const refuseHead: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "HEAD") return c.json({ code: "forbidden" }, 403);
  await next();
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
  app.use("*", refuseHead);
  registerInternalRoutes(app);
  return app;
}
