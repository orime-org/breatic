// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The operations ledger's audit lines (inner#1968, design 3.2.1): domain
 * hands the facts over, and the service writes them to its log.
 */

import { logger } from "@breatic/core";
import { operationService } from "@breatic/domain";

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
