// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The internal app's error exit (inner#1410 §4.6). Its callers are programs,
 * so every answer is `{ code, detail? }` (a `stripe_blocks` refusal adds
 * `reason`) with a stable code to branch on; `detail` is the English sentence
 * of `server.internal.<key>`, or a domain `AppError`'s own message.
 */

import type { Context, ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";
import { t } from "@breatic/shared";
import { AppError, ValidationError } from "@core/app-errors.js";

/** The code each domain `AppError` status answers with. */
const APP_ERROR_CODES: Partial<Record<number, string>> = {
  404: "not_found",
  409: "lot_state_changed",
  422: "invalid_body",
};

/** What a service hands {@link createInternalErrorHandler}. */
export interface InternalErrorHandlerDeps {
  /** The service's own refusals, answered before the shared codes; undefined passes the error on. */
  refine?: (err: Error, c: Context) => Response | undefined;
  /** Log an error that no rule answered. */
  report: (event: { err: unknown; path: string; method: string }) => void;
}

/**
 * Build an internal listener's error handler.
 * @param deps - The service's own refusals and the log sink.
 * @returns The handler for `app.onError`.
 */
export function createInternalErrorHandler(deps: InternalErrorHandlerDeps): ErrorHandler {
  /**
   * Answer whatever a handler threw, by who caused it.
   * @param err - What was thrown.
   * @param c - The request context.
   * @returns The response.
   */
  const internalErrorHandler: ErrorHandler = (err, c) => {
    const refined = deps.refine?.(err, c);
    if (refined) return refined;
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
    deps.report({ err, path: c.req.path, method: c.req.method });
    return c.json({ code: "internal_error" }, 500);
  };

  return internalErrorHandler;
}
