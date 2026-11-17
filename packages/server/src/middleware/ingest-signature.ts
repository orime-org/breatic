// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ingest Worker's requests to our server (inner#1953): signed with the shared secret over a timestamp and the raw
 * body (`verifyModelKeysRequest` in `@breatic/shared/space-content`, which the Worker signs with too), within the
 * window `config/timeline.yaml` sets. Anything else is 401 `{ code: "unauthorized" }`; a deployment without the secret
 * refuses every request.
 */

import type { MiddlewareHandler } from "hono";
import { env, getTimelineConfig, logger } from "@breatic/core";
import { MODEL_KEYS_SIGNATURE_HEADER, MODEL_KEYS_TIMESTAMP_HEADER, verifyModelKeysRequest } from "@breatic/shared/space-content";

/**
 * Refuse any request the ingest Worker did not sign.
 * @returns The middleware.
 */
export function ingestSignature(): MiddlewareHandler {
  return async (c, next) => {
    const verdict = await verifyModelKeysRequest({
      secret: env.INGEST_SHARED_SECRET,
      timestamp: c.req.header(MODEL_KEYS_TIMESTAMP_HEADER),
      signature: c.req.header(MODEL_KEYS_SIGNATURE_HEADER),
      body: await c.req.text(),
      nowSeconds: Math.floor(Date.now() / 1000),
      windowSeconds: getTimelineConfig().web_animation.key_request_window_seconds,
    });
    if (verdict !== "ok") {
      logger.warn({ step: verdict, path: c.req.path }, "ingest_signature_rejected");
      return c.json({ code: "unauthorized" }, 401);
    }
    await next();
  };
}
