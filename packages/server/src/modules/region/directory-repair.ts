// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Repairing one Studio's directory row (inner#1955, design 6.9 and 6.13): the
 * global region finds the Studio's region in the directory and has that
 * region send the Studio's whole state as a snapshot on its ordered outbox
 * channel, which is how a dead-lettered event is made good.
 */

import { callRegion, env, getRegionsConfig, studioDirectoryRepo } from "@breatic/core";
import { studioDirectoryService } from "@breatic/domain";

/**
 * Have the Studio's region send a snapshot of it to the directory.
 * @param studioId - The Studio.
 * @returns `emitted`, or `not_found` when the directory has no live Studio by that id.
 * @throws {GlobalApiError} When the Studio's region did not answer or refused.
 */
export async function repairStudioDirectory(studioId: string): Promise<"emitted" | "not_found"> {
  const row = await studioDirectoryRepo.findLive(studioId);
  if (row === null) return "not_found";
  const region = row.region ?? env.GLOBAL_REGION;
  const emitted =
    region === env.REGION
      ? await studioDirectoryService.emitStudioSnapshot(studioId)
      : (await callRegion(region, "emitStudioSnapshot", [studioId], getRegionsConfig().global_api_timeout_ms)) === true;
  // A directory row whose Studio its region does not hold has nothing to repair from.
  return emitted ? "emitted" : "not_found";
}
