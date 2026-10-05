// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { creditLotService } from "@breatic/domain";
import type { CreditLotEntity } from "@breatic/shared";

/**
 * Point a purchased credit pack at a studio, or unassign it.
 * @param input - Which pack, on whose behalf, and where to.
 * @param input.lotId - The pack to designate.
 * @param input.requestingUserId - Who is asking. Must be the buyer.
 * @param input.studioId - The studio to point it at, or null to unassign.
 * @returns The pack as it now stands.
 * @throws {NotFoundError} If the pack does not exist or belongs to someone else.
 * @throws {ForbiddenError} If the caller does not administer the target studio.
 * @throws {AppError} 409 if the pack is in the refund flow.
 */
export async function designateLot(input: {
  lotId: string;
  requestingUserId: string;
  studioId: string | null;
}): Promise<CreditLotEntity> {
  return creditLotService.designateLot(input);
}
