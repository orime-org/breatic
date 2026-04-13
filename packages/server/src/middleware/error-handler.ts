/**
 * Global error handler middleware.
 *
 * Catches {@link AppError} subclasses and returns structured JSON.
 * Unknown errors return 500.
 */

import type { ErrorHandler } from "hono";
import { AppError } from "@breatic/core";
import { logger } from "@breatic/core";

/** Global error handler for the Hono app. */
export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return c.json(
      { error: { code: err.statusCode, message: err.message } },
      err.statusCode as 400,
    );
  }

  logger.error({ err }, "Unhandled error");
  return c.json(
    { error: { code: 500, message: "Internal server error" } },
    500,
  );
};
