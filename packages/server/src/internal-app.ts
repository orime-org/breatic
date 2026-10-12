// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The internal API (inner#1410 §4): a second Hono app on its own port, for
 * the back office alone. Nothing here is mounted on the public app.
 *
 * Every request passes, in order: the rate limit by connection address
 * (fail closed), the signature and nonce, then the authorisation table;
 * whatever the table does not list is 403.
 */

import { Hono } from "hono";
import { internalAuth } from "@server/middleware/internal-auth.js";
import { internalErrorHandler } from "@server/middleware/internal-errors.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { registerInternalRoutes } from "@server/routes/internal/index.js";

/**
 * Build the internal app.
 * @returns The app, ready for `serve`.
 */
export function createInternalApp(): Hono {
  const app = new Hono();
  app.onError(internalErrorHandler);
  app.notFound((c) => c.json({ code: "forbidden" }, 403));
  app.use(
    "*",
    rateLimitFor("internal-api", "socket", {
      onLimited: (c) => c.json({ code: "rate_limited" }, 429),
      failClosed: (c) => c.json({ code: "unavailable" }, 503),
    }),
  );
  app.use("*", internalAuth());
  registerInternalRoutes(app);
  return app;
}
