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
 * The 413 answer for a body over a limit, naming the limit.
 * @param c - The request context.
 * @param limitBytes - The limit in bytes.
 * @returns The 413 answer.
 */
export function payloadTooLarge(c: Context, limitBytes: number): Response {
  return c.json(
    { error: { code: 413, message: t("server.error.payload_too_large", { limit: formatBytes(limitBytes) }) } },
    413,
  );
}

/**
 * Refuse a body over the limit: log who sent it and answer 413 with the reason.
 * @param c - The request context.
 * @param maxSize - The limit in bytes.
 * @returns The 413 answer.
 */
async function refuse(c: Context, maxSize: number): Promise<Response> {
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
  return payloadTooLarge(c, maxSize);
}

/** The limit and the counting limiter, built on the first request that needs them. */
let built: { maxSize: number; counting: MiddlewareHandler } | undefined;

/**
 * The limit and the counting limiter, read and built on first use, so
 * importing the app reads no configuration.
 * @returns Both.
 */
function limiter(): { maxSize: number; counting: MiddlewareHandler } {
  if (built === undefined) {
    const maxSize = getRequestBodyMaxBytes();
    built = { maxSize, counting: bodyLimit({ maxSize, onError: (c) => refuse(c, maxSize) }) };
  }
  return built;
}

/**
 * Refuse any request body larger than `request_body_max_bytes` with 413.
 *
 * A declared length is judged from the header alone and the body is left
 * untouched: in `@hono/node-server`, reading `c.req.raw.body` wraps the socket
 * in a web stream, and a body then left unread (a route that refuses before
 * reading it) keeps the socket paused, so the adapter's drain gives up and
 * destroys the connection the client reuses next. A chunked body has no
 * declared length and is counted as it arrives, through hono's `bodyLimit`;
 * so is a body handed in as a stream with neither header, which only an
 * in-process `Request` can carry (over HTTP/1.1 such a request has no body).
 * @param c - The request context.
 * @param next - The rest of the chain, reached only for a body within the limit.
 * @returns The 413 answer, or nothing once the chain has run.
 */
export const requestBodyLimit: MiddlewareHandler = async (c, next) => {
  const declared = c.req.header("content-length");
  const chunked = c.req.header("transfer-encoding") !== undefined;
  if (declared !== undefined && !chunked) {
    const { maxSize } = limiter();
    return Number.parseInt(declared, 10) > maxSize ? refuse(c, maxSize) : next();
  }
  if (!chunked && !c.req.raw.body) return next();
  return limiter().counting(c, next);
};
