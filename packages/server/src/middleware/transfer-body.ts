// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The transfer reference's HTTP side (inner#1006): on a route that takes
 * `{ "transfer": "<storageKey>" }` in place of its body, this hands the
 * reference to `transferReferenceService`, answers its refusals, and gives the
 * route's own `validate` the original request, so nothing after it changes.
 * The rules a reference must pass live in the service.
 */

import type { MiddlewareHandler } from "hono";
import { logger } from "@breatic/core";
import { formatBytes, t } from "@breatic/shared";
import type { AuthVariables } from "@server/middleware/auth.js";
import { transferReferenceService } from "@server/modules";

/**
 * The key a body references, when it is exactly `{ "transfer": "<string>" }`.
 * @param text - The request body.
 * @returns The key, or undefined for any other body.
 */
function referencedKey(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the route's own validate answers it.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "transfer") return undefined;
  const value = (parsed as { transfer: unknown }).transfer;
  return typeof value === "string" ? value : undefined;
}

/**
 * Accept `{ "transfer": "<storageKey>" }` on a route in place of its body.
 * Mount after the route's rate limit and before its `validate`; any other
 * body passes through untouched.
 * @param route - Which route this is, for its read cap.
 * @returns The middleware.
 */
export function acceptTransferBody(
  route: transferReferenceService.TransferRoute,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const key = referencedKey(await c.req.text());
    if (key === undefined) return next();
    const userId = c.get("user").id;
    const ctx = { key, userId };

    const read = await transferReferenceService.readTransferReference(route, key, userId);
    switch (read.kind) {
      case "busy":
        c.header("Retry-After", "1");
        return c.json({ error: { code: 429, message: t("server.error.rate_limited") } }, 429);
      case "rejected":
        logger.warn(
          { reason: read.reason, ...ctx, ...(read.ownerId === undefined ? {} : { ownerId: read.ownerId }) },
          "transfer_rejected",
        );
        return c.json({ error: { code: 400, message: t("server.error.transfer_invalid") } }, 400);
      case "too_large":
        logger.warn({ ...ctx, cap: read.cap }, "transfer_too_large");
        return c.json(
          { error: { code: 413, message: t("server.error.payload_too_large", { limit: formatBytes(read.cap) }) } },
          413,
        );
      case "read_failed":
        logger.error({ err: read.err, key, userId }, "transfer_read_failed");
        return c.json({ error: { code: 502, message: t("server.error.internal") } }, 502);
      case "ok":
        break;
    }

    // The route's validate reads the original body, as JSON: hono's validator
    // refuses a body without this content type.
    const raw = c.req.raw;
    const headers = new Headers(raw.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    c.req.raw = new Request(raw.url, {
      method: raw.method,
      headers,
      body: read.text,
      // Kept so a stream answering this request still hears the client leave.
      signal: raw.signal,
      duplex: "half",
    } as RequestInit);
    c.req.bodyCache = {};
    await next();
  };
}
