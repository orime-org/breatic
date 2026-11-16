// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Count derived uploads no operation used up in time (inner#1968, design
 * 3.2.1), and write the ledger's audit facts this process produces as log
 * lines.
 */

import { logger } from "@breatic/core";
import { operationService } from "@breatic/domain";

/** The queue holding the recurring sweep. */
export const OPERATION_DEFERRED_SWEEP_QUEUE = "operation-deferred-sweep";

/**
 * One round of the sweep.
 * @returns Once every due row has been tried.
 * @throws {Error} When the database fails; what is left waits for the next round.
 */
export async function sweepDeferredOperations(): Promise<void> {
  const counted = await operationService.sweepDeferredOperations();
  if (counted > 0) logger.info({ counted }, "operation_deferred_sweep_counted");
}

let attached = false;

/**
 * Write every audit fact the ledger produces in this process as one log line
 * named by the fact. Attaching twice attaches once.
 */
export function attachOperationAuditLog(): void {
  if (attached) return;
  attached = true;
  operationService.onOperationAudit(({ msg, ...fields }) => {
    logger.info(fields, msg);
  });
}
