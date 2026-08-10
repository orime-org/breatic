// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Global error handler middleware.
 *
 * The single place that decides what a client is told. It answers on its own
 * terms for the two things it can recognise as the caller's doing, and
 * everything else is ours: a 500 plus `Unhandled error`, which is what makes
 * a fault reconstructable afterwards.
 *
 * Recognising a rejected request by the TYPE of exception does not work, and
 * a first version of this handler tried it. `ZodError` and `SyntaxError` say
 * that a parse failed, not whose input failed — our own config loaders parse
 * operator-written yaml inside a request (`config/rate-limits.ts` and three
 * siblings, lazily, on first use), and any `await response.json()` on an
 * upstream that answered with an HTML error page raises the same type. Both
 * were being answered "your input is invalid", to a user who had typed
 * nothing wrong, with the log line dropped.
 *
 * So the rule is provenance, not type. Two exceptions reach here already
 * carrying the fact that a client caused them:
 *
 *   AppError        thrown by our own service and route layer, including the
 *                   ValidationError that `validate` raises for a bad field
 *   HTTPException   thrown by hono when it cannot read the request body
 *
 * A library's own wording never reaches the wire — it is hardcoded English
 * and names our internals — so what a client reads for those two is built
 * here, in the caller's language. An `AppError` carries whatever message its
 * thrower built, which is that thrower's business, not this file's.
 */

import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { AppError, ConflictLockedError } from "@breatic/core";
import { logger } from "@breatic/core";
import { t } from "@breatic/shared";

/**
 * Global error handler for the Hono app.
 * @param err - The thrown error to map to an HTTP response.
 * @param c - The Hono request context used to build the JSON response.
 * @returns A structured JSON response: the locked-resource detail for {@link ConflictLockedError}, the status + message for {@link AppError}, or a 500 for unknown errors.
 */
export const errorHandler: ErrorHandler = (err, c) => {
  // ConflictLockedError carries a structured `detail` payload (holder
  // identity / start time / etc.) that the client renders into a toast.
  // Preserve it on the wire instead of flattening to {message}.
  if (err instanceof ConflictLockedError) {
    return c.json(
      {
        error: {
          code: err.statusCode,
          name: err.name,
          message: err.message,
          detail: err.detail,
        },
      },
      err.statusCode as 409,
    );
  }

  if (err instanceof AppError) {
    // Auth-class client errors (401 Unauthorized / 403 Forbidden) are
    // security-relevant rejections — surface them as structured warns
    // per the "security monitoring" mandate. Other AppErrors (404 /
    // 409 / validation) are normal business outcomes, not logged here.
    if (err.statusCode === 401 || err.statusCode === 403) {
      logger.warn(
        { status: err.statusCode, name: err.name, path: c.req.path },
        "auth_rejected",
      );
    }
    return c.json(
      { error: { code: err.statusCode, message: err.message } },
      err.statusCode as 400,
    );
  }

  // hono throws this from inside the validator when the body cannot be read,
  // and from its own middleware. It already carries the status it wants, so
  // take that rather than deciding again — but never its message, which is
  // hardcoded English naming our internals ("Malformed JSON in request body").
  if (err instanceof HTTPException) {
    if (err.status >= 500) {
      logger.error({ err, status: err.status }, "Unhandled error");
    }
    return c.json(
      {
        error: {
          code: err.status,
          message:
            err.status >= 500
              ? t("server.error.internal")
              : t("server.error.validation"),
        },
      },
      err.status,
    );
  }

  // Everything else is ours until proven otherwise, including a bare
  // `ZodError` or `SyntaxError` — those name a failed parse without naming
  // whose input failed, and the ones that actually occur here come from our
  // own config loaders and upstream calls. They belong in the log.
  logger.error({ err }, "Unhandled error");
  return c.json(
    { error: { code: 500, message: t("server.error.internal") } },
    500,
  );
};
