// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The daily lot-mirror reconcile (inner#1993 §5.4): resends bought lots'
 * current lifecycle to the billing service. It runs only where the
 * deployment sells; the worker schedules it then.
 */

import { getCommerceConfig, logger } from "@breatic/core";
import { creditLotService } from "@breatic/domain";

/**
 * One reconcile pass.
 * @returns Once every lot in scope has been resent.
 * @throws {Error} When the database fails; BullMQ records the failed job.
 */
export async function reconcileLotMirror(): Promise<void> {
  const resent = await creditLotService.resendLotMirror(getCommerceConfig().lot_mirror_reconcile_window_days);
  logger.info({ resent }, "commerce_lot_mirror_resent");
}
