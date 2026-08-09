// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Global error handler middleware.
 *
 * The single place that decides what a client is told, so it has to
 * recognise every exception type that can reach it. Anything it does not
 * recognise becomes a 500 — which, for the three shapes a client can trigger
 * by sending a bad request, means telling the caller the server broke when it
 * did not, and writing an incident-shaped log line every time.
 *
 * Which exception arrives depends on who parsed the body:
 *
 *   the validator middleware   bad field -> ZodError, converted by our hook
 *                              bad body  -> HTTPException(400), it catches
 *   a hand-written parse       bad field -> bare ZodError
 *   in a route handler         bad body  -> native SyntaxError
 *
 * The wording is always ours and always localised: a library's own message is
 * hardcoded English and names our internals, so it never reaches the wire.
 */

import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { AppError, ConflictLockedError } from "@breatic/core";
import { logger } from "@breatic/core";
import { t } from "@breatic/shared";

/** A rejected request is the client's error; the status says which kind. */
const BODY_UNREADABLE = 400;
const INPUT_INVALID = 422;

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

  // A hand-written `schema.parse(...)` in a route throws this bare, with no
  // middleware to convert it. zod 4 packs its whole report — including the
  // pattern it tested against — into `message`, so none of it goes on the
  // wire: the caller is told the input was rejected, not how we check it.
  if (err instanceof ZodError) {
    return c.json(
      {
        error: { code: INPUT_INVALID, message: t("server.error.validation") },
      },
      INPUT_INVALID,
    );
  }

  // `await c.req.json()` called directly in a route handler throws the native
  // parser error. The body could not be read at all, which is a different
  // failure from a body we read and rejected.
  if (err instanceof SyntaxError) {
    return c.json(
      {
        error: {
          code: BODY_UNREADABLE,
          message: t("server.error.validation"),
        },
      },
      BODY_UNREADABLE,
    );
  }

  logger.error({ err }, "Unhandled error");
  return c.json(
    { error: { code: 500, message: t("server.error.internal") } },
    500,
  );
};
