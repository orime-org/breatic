// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The product's after-reply work list (core's `createAfterReply`): routes
 * start work here after deciding their reply, and shutdown waits for it.
 */

import { createAfterReply, logger } from "@breatic/core";

export const { runAfterReply, settleAfterReply, pendingAfterReply } = createAfterReply({
  onFailed: (err, ctx) => logger.error({ err, ...ctx }, "after_reply_failed"),
});
