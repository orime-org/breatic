// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The internal API (inner#1410 §4): a second Hono app on its own port, for
 * the back office and the billing service (inner#1993 §3.1). Nothing here is
 * mounted on the public app.
 *
 * Every request passes, in order: one log line for it, the rate limit by
 * connection address (fail closed; `/internal/v1/commerce/` counts against
 * `commerce-api`, everything else against `internal-api`), the body size
 * limit, the signature and nonce, a 403 for HEAD, then the authorisation
 * table; whatever the table does not list is 403.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { closeAfterRefusal, createLogRequest, holdsOnlyStorableText, logger, ValidationError } from "@breatic/core";
import { t } from "@breatic/shared";
import { getRequestBodyLingerSeconds } from "@server/config/limits.js";
import { COMMERCE_PREFIX, internalAuth } from "@server/middleware/internal-auth.js";
import { internalErrorHandler } from "@server/middleware/internal-errors.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { registerInternalRoutes } from "@server/routes/internal/index.js";

/** Every internal body is a few KiB; the largest, a 100-id lookup, is about 4 KiB. */
const MAX_BODY_BYTES = 64 * 1024;

/** One structured line per request, refused ones included (acceptance #14). */
const logRequest = createLogRequest((line) => logger.info(line, "internal_api_request"));

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
 * Refuse a JSON body holding text the database cannot store (NUL, a lone
 * surrogate): every internal endpoint writes what it is sent, and Postgres
 * would otherwise fail the write with a 500.
 * @param c - The request context.
 * @param next - The rest of the app.
 * @returns Nothing; the route answers.
 * @throws {ValidationError} When the body holds such text.
 */
const refuseUnstorableText: MiddlewareHandler = async (c, next) => {
  const text = await c.req.text();
  if (text !== "") {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // Unparseable bodies are answered by the route's own validation.
      await next();
      return;
    }
    if (!holdsOnlyStorableText(body)) throw new ValidationError(t("server.internal.invalid_body"));
  }
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
  const refusals = {
    onLimited: (c: Context) => c.json({ code: "rate_limited" }, 429),
    failClosed: (c: Context) => c.json({ code: "unavailable" }, 503),
  };
  const commerceLimit = rateLimitFor("commerce-api", "socket", refusals);
  const backOfficeLimit = rateLimitFor("internal-api", "socket", refusals);
  app.use("*", (c, next) => (c.req.path.startsWith(COMMERCE_PREFIX) ? commerceLimit : backOfficeLimit)(c, next));
  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => {
        closeAfterRefusal(c, getRequestBodyLingerSeconds);
        return c.json({ code: "invalid_body" }, 413);
      },
    }),
  );
  app.use("*", internalAuth());
  app.use("*", refuseHead);
  app.use("*", refuseUnstorableText);
  registerInternalRoutes(app);
  return app;
}
