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

/** Global error handler for the Hono app. */
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
