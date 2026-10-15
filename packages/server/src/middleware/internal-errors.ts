// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The internal app's error exit (inner#1410 §4.6). Its callers are programs,
 * so every answer is `{ code, detail? }` (a `stripe_blocks` refusal adds
 * `reason`) with a stable code to branch on; `detail` is the English sentence
 * of `server.internal.<key>`, or a domain `AppError`'s own message.
 */

import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";
import { AppError, ValidationError, logger } from "@breatic/core";
import { t } from "@breatic/shared";
import { RefundRefusal } from "@server/modules/credit-refund/refusal.js";

/** The code each domain `AppError` status answers with. */
const APP_ERROR_CODES: Partial<Record<number, string>> = {
  404: "not_found",
  409: "lot_state_changed",
  422: "invalid_body",
};

/**
 * Answer whatever a handler threw, by who caused it.
 * @param err - What was thrown.
 * @param c - The request context.
 * @returns The response.
 */
export const internalErrorHandler: ErrorHandler = (err, c) => {
  if (err instanceof RefundRefusal) {
    return c.json(
      {
        code: err.code,
        ...(err.detailKey !== undefined && { detail: t(`server.internal.${err.detailKey}`) }),
        ...(err.reason !== undefined && { reason: err.reason }),
      },
      err.status,
    );
  }
  // Thrown by validate(), whose message is the public app's sentence.
  if (err instanceof ValidationError) {
    return c.json({ code: "invalid_body", detail: t("server.internal.invalid_body") }, 422);
  }
  if (err instanceof HTTPException && err.status === 400) {
    return c.json({ code: "invalid_body", detail: t("server.internal.unreadable_body") }, 400);
  }
  if (err instanceof AppError) {
    const code = APP_ERROR_CODES[err.statusCode];
    if (code !== undefined) {
      return c.json({ code, detail: err.message }, err.statusCode as ContentfulStatusCode);
    }
  }
  logger.error({ err, path: c.req.path, method: c.req.method }, "internal_api_error");
  return c.json({ code: "internal_error" }, 500);
};
