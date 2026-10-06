// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ConflictError } from "@breatic/core";
import { creditLotService, studioMembersRepo } from "@breatic/domain";
import { t } from "@breatic/shared";
import type { CreditLotEntity } from "@breatic/shared";
import * as transfersRepo from "@server/modules/studio/studioTransfers.repo.js";

/**
 * Point a purchased credit pack at a studio, or unassign it.
 *
 * A studio whose transfer waits takes no new pack: the transfer started on the
 * condition that none pointed at it. This check and the offer are not taken
 * under one lock; a pack that slips in between is cleared when the transfer is
 * accepted, so the admin who leaves never keeps paying for the studio.
 * Unassigning is always allowed.
 * @param input - Which pack, on whose behalf, and where to.
 * @param input.lotId - The pack to designate.
 * @param input.requestingUserId - Who is asking. Must be the buyer.
 * @param input.studioId - The studio to point it at, or null to unassign.
 * @returns The pack as it now stands.
 * @throws {ConflictError} If the caller administers the target and its transfer is waiting.
 * @throws {NotFoundError} If the pack does not exist or belongs to someone else.
 * @throws {ForbiddenError} If the caller does not administer the target studio.
 * @throws {AppError} 409 if the pack is in the refund flow.
 */
export async function designateLot(input: {
  lotId: string;
  requestingUserId: string;
  studioId: string | null;
}): Promise<CreditLotEntity> {
  // Only an admin of the target hears about its transfer; anyone else falls
  // through to the 403 and its audit line, as when nothing is pending.
  if (
    input.studioId !== null &&
    (await studioMembersRepo.getRole(input.studioId, input.requestingUserId)) === "admin" &&
    (await transfersRepo.findLiveForContainer(input.studioId)) !== null
  ) {
    throw new ConflictError(t("server.studio.designation_during_transfer"));
  }
  return creditLotService.designateLot(input);
}
