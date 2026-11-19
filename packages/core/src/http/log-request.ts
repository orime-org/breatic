// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One structured line per request on an internal listener, refused ones
 * included, in the same shape on every service.
 */

import type { MiddlewareHandler } from "hono";

/** The line an internal listener writes for each request. */
export interface InternalRequestLine {
  adminId: string | undefined;
  method: string;
  path: string;
  idempotencyKey: string | undefined;
  reason: string | undefined;
  status: number;
  code: string | undefined;
  durationMs: number;
}

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
 * Build the request-line middleware; register it first, so it sees the status
 * every later step answered with.
 * @param report - Log one line.
 * @returns The middleware.
 */
export function createLogRequest(report: (line: InternalRequestLine) => void): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    await next();
    report({
      adminId: c.get("internalAdmin"),
      method: c.req.method,
      path: c.req.path,
      idempotencyKey: c.req.header("idempotency-key"),
      reason: c.get("internalReason"),
      status: c.res.status,
      code: c.res.status >= 400 ? await answerCode(c.res) : undefined,
      durationMs: Date.now() - start,
    });
  };
}
