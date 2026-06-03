// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * CORS middleware configuration.
 *
 * Reads allowed origins from the `ALLOWED_ORIGINS` environment variable.
 */

import { cors } from "hono/cors";
import { env } from "@breatic/core";

/**
 * CORS middleware configured from environment.
 *
 * `credentials: true` is required so the browser sends + accepts the
 * httpOnly session cookie on cross-origin XHR. With credentials on,
 * `Access-Control-Allow-Origin` MUST be a specific origin (never `*`)
 * — the env `ALLOWED_ORIGINS` whitelist enforces this.
 *
 * `Authorization` is no longer in `allowHeaders`: Bearer-header auth
 * was removed in the cookie migration (2026-05-26). Removing it cuts
 * an unnecessary cross-origin preflight allow that no longer matches
 * any client code path.
 */
export const corsMiddleware = cors({
  origin: env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()),
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type"],
});
