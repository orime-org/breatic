// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The product internal listener's error exit: core's handler, logged here.
 */

import { createInternalErrorHandler, logger } from "@breatic/core";

export const internalErrorHandler = createInternalErrorHandler({
  report: (event) => logger.error(event, "internal_api_error"),
});
