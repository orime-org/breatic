/**
 * CORS middleware configuration.
 *
 * Reads allowed origins from the `ALLOWED_ORIGINS` environment variable.
 */

import { cors } from "hono/cors";
import { env } from "@breatic/core";

/** CORS middleware configured from environment. */
export const corsMiddleware = cors({
  origin: env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()),
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
});
