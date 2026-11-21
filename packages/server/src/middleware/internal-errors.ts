// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The product internal listener's error exit: core's handler plus the
 * credit-refund refusals, which answer with their own body.
 */

import { createInternalErrorHandler, logger } from "@breatic/core";
import { RefundRefusal, refusalBodyOf } from "@server/modules/credit-refund/refusal.js";

export const internalErrorHandler = createInternalErrorHandler({
  refine: (err, c) => (err instanceof RefundRefusal ? c.json(refusalBodyOf(err), err.status) : undefined),
  report: (event) => logger.error(event, "internal_api_error"),
});
