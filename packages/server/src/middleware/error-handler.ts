// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The public app's error exit: core's error handler, its events logged here.
 * Auth-class rejections are warnings; anything the handler did not recognise
 * as the caller's doing is `Unhandled error`.
 */

import { createErrorHandler, logger } from "@breatic/core";

export const errorHandler = createErrorHandler({
  report: (event) => {
    if (event.kind === "auth_rejected") {
      logger.warn({ status: event.status, name: event.name, path: event.path }, "auth_rejected");
      return;
    }
    logger.error(event.status === undefined ? { err: event.err } : { err: event.err, status: event.status }, "Unhandled error");
  },
});
