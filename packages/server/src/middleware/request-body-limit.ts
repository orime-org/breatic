// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The public app's request body limit (inner#1006).
 *
 * Mounted before every route, signed-in or not. A body declared larger than
 * `request_body_max_bytes` is refused without reading a byte of it; a chunked
 * body is counted as it arrives and refused the moment it passes the limit,
 * so the process never holds more than the limit of any one request. Routes
 * that legitimately carry more take a transfer reference instead
 * (`middleware/transfer-body.ts`).
 */

import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "@hono/node-server/conninfo";
import { decideClientIdentity, logger } from "@breatic/core";
import { formatBytes, t } from "@breatic/shared";
import { getRequestBodyMaxBytes } from "@server/config/limits.js";
import { readSessionCookie } from "@server/middleware/session-cookie.js";
import { authService } from "@server/modules";

/**
 * The size the request declared, for the log.
 * @param c - The request context.
 * @returns `Content-Length` as a number, or null when a chunked body has none.
 */
function declaredLength(c: Context): number | null {
  const header = c.req.header("content-length");
  return header === undefined ? null : Number.parseInt(header, 10);
}

/**
 * Who sent the refused body, when the request carries a live session.
 * Looked up the way `requireAuth` does, once, only for a refusal.
 * @param c - The request context.
 * @returns The user id, or null with no session, a dead one, or a failed lookup.
 */
async function sessionUserId(c: Context): Promise<string | null> {
  const token = readSessionCookie(c);
  if (!token) return null;
  try {
    return (await authService.getUserByToken(token))?.id ?? null;
  } catch (err) {
    logger.error({ err, path: c.req.path }, "request_body_session_lookup_failed");
    return null;
  }
}

/**
 * The hono limiter for one limit, answering 413 with the reason and logging
 * who sent it.
 * @param maxSize - The limit in bytes.
 * @returns The limiter.
 */
function limiterFor(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: async (c) => {
      logger.warn(
        {
          path: c.req.path,
          method: c.req.method,
          declaredBytes: declaredLength(c),
          client: decideClientIdentity({
            peerAddress: getConnInfo(c).remote.address,
            realIpHeader: c.req.header("x-real-ip"),
          }),
          userId: await sessionUserId(c),
        },
        "request_body_too_large",
      );
      return c.json(
        { error: { code: 413, message: t("server.error.payload_too_large", { limit: formatBytes(maxSize) }) } },
        413,
      );
    },
  });
}

let limiter: MiddlewareHandler | undefined;

/**
 * Refuse any request body larger than `request_body_max_bytes` with 413. The
 * limit is read on the first request that carries a body, so importing the
 * app reads no configuration.
 * @param c - The request context.
 * @param next - The rest of the chain, reached only for a body within the limit.
 * @returns The 413 answer, or nothing once the chain has run.
 */
export const requestBodyLimit: MiddlewareHandler = async (c, next) => {
  if (!c.req.raw.body) return next();
  limiter ??= limiterFor(getRequestBodyMaxBytes());
  return limiter(c, next);
};
