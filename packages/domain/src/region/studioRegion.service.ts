// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The region's half of creating a Studio (inner#1955): writing it under the
 * id the global region chose, and deciding, when the global region gives a
 * creation up, whether it already landed. Both decide under one lock per
 * Studio id, so a late creation and an abandonment never both win.
 */

import { db } from "@breatic/core";
import * as studioMembersRepo from "@domain/auth/studioMembers.repo.js";
import * as tombstoneRepo from "@domain/region/studioCreationTombstone.repo.js";
import * as studioRepo from "@domain/studio/studio.repo.js";

/** What the global region asks the region to create. */
export interface RegionStudioInput {
  studioId: string;
  slug: string;
  name: string;
  type: "personal" | "team";
  adminUserId: string;
}

/**
 * Write the Studio and its admin here, once.
 * @param input - The Studio as the global region reserved it.
 * @returns `created`, `exists` when it was written before, or `abandoned`
 *   when the global region gave the id up first.
 */
export async function createStudioInRegion(input: RegionStudioInput): Promise<"created" | "exists" | "abandoned"> {
  return db.transaction(async (tx) => {
    await tombstoneRepo.lockStudioId(input.studioId, tx);
    if (await tombstoneRepo.isAbandoned(input.studioId, tx)) return "abandoned";
    if (await studioRepo.existsById(input.studioId, tx)) return "exists";
    if (input.type === "personal") {
      await studioRepo.createPersonalStudio(input.adminUserId, input.slug, input.name, tx, input.studioId);
    } else {
      await studioRepo.createTeamStudio(input.adminUserId, input.slug, input.name, tx, input.studioId);
    }
    await studioMembersRepo.insertAdmin(input.studioId, input.adminUserId, tx);
    return "created";
  });
}

/**
 * Give a creation up unless it already landed: a tombstone keeps a creation
 * that arrives later from writing a Studio no directory row knows.
 * @param studioId - The id.
 * @returns `exists` when the Studio is here, otherwise `abandoned`.
 */
export async function abandonStudioInRegion(studioId: string): Promise<"exists" | "abandoned"> {
  return db.transaction(async (tx) => {
    await tombstoneRepo.lockStudioId(studioId, tx);
    if (await studioRepo.existsById(studioId, tx)) return "exists";
    await tombstoneRepo.recordAbandoned(studioId, tx);
    return "abandoned";
  });
}
