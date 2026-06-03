/**
 * Global error handler middleware.
 *
 * Catches {@link AppError} subclasses and returns structured JSON.
 * Unknown errors return 500.
 */

import type { ErrorHandler } from "hono";
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

  logger.error({ err }, "Unhandled error");
  return c.json(
    { error: { code: 500, message: t("server.error.internal") } },
    500,
  );
};
