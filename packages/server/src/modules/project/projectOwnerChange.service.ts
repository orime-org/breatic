// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { DbTx } from "@breatic/core";
import * as projectJoinRequestService from "@server/modules/project-join-request/projectJoinRequest.service.js";

/**
 * A project just changed owner: move every pending request that waits on its
 * owner to the new one.
 *
 * Called by every path that writes a new owner row, inside that path's
 * transaction and after the write. Each kind of request addressed to the owner
 * is re-addressed here, so a path that changes the owner cannot leave one of
 * them behind.
 * @param projectId - The project.
 * @param newOwnerUserId - Its owner now.
 * @param tx - The transaction that wrote the owner row.
 */
export async function onProjectOwnerChanged(
  projectId: string,
  newOwnerUserId: string,
  tx: DbTx,
): Promise<void> {
  await projectJoinRequestService.readdressOnOwnerChange(projectId, newOwnerUserId, tx);
}
