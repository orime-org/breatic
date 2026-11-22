// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Ending Project transfers that timed out (#1580). A pending offer past its `expires_at` is written `failed` /
 * `expired` and its bell entry is taken down in the same transaction, so the entry never outlives the offer; the
 * table triggers then tell the Project's members and the recipient. The deadline sweep runs it for every Project, and
 * filing a new offer runs it for that Project first, to free the one pending slot.
 */

import { db, type DbTx } from "@breatic/core";
import * as notificationRepo from "@domain/notification/notification.repo.js";
import * as projectTransfersRepo from "@domain/project/projectTransfers.repo.js";

/**
 * End the pending transfers that are due.
 * @param scope - Which transfers: one Project's, or every Project's when absent.
 * @param scope.projectId - The Project, when only its transfers count.
 * @param scope.now - The instant they are judged at; the database's own time when absent.
 * @param tx - The transaction to run in; a transaction of its own when absent.
 * @returns How many transfers it ended.
 * @throws {Error} When a write fails; nothing of it is kept then.
 */
export async function expireDueTransfers(scope: { projectId?: string; now?: Date }, tx?: DbTx): Promise<number> {
  /**
   * End them inside one transaction.
   * @param inner - The transaction.
   * @returns How many it ended.
   */
  const run = async (inner: DbTx): Promise<number> => {
    const retired = await projectTransfersRepo.expireStalePending(scope, inner);
    for (const id of retired.notificationIds) await notificationRepo.retire(id, inner);
    return retired.count;
  };
  return tx ? run(tx) : db.transaction(run);
}
