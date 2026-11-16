// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The calls between the global region and the other regions (inner#1955).
 *
 * `REGION_FUNCTIONS` is what a region serves at `/internal/region/<fn>`
 * (`packages/server/src/routes/internal/global.ts`); {@link regionClient} is
 * how the global region reaches one region's.
 */

import { callRegion, env, getRegionsConfig } from "@breatic/core";
import type { RegionClient, RegionClientFactory } from "@domain/region/studioCreation.service.js";
import { emitStudioSnapshot } from "@domain/region/studioDirectory.service.js";
import {
  abandonStudioInRegion,
  createStudioInRegion,
  type RegionStudioInput,
} from "@domain/region/studioRegion.service.js";

/** The functions a region serves to the global region. */
export const REGION_FUNCTIONS = {
  /**
   * Answer, so the global region knows this region can take a Studio.
   * @returns `ok`.
   */
  probe: async (): Promise<"ok"> => "ok",
  /**
   * Write a Studio the global region reserved.
   * @param input - The Studio.
   * @returns `created`, `exists` or `abandoned`.
   */
  createStudio: (input: RegionStudioInput): Promise<"created" | "exists" | "abandoned"> => createStudioInRegion(input),
  /**
   * Give up a creation unless it landed.
   * @param studioId - The Studio id.
   * @returns `exists` or `abandoned`.
   */
  abandonStudio: (studioId: string): Promise<"exists" | "abandoned"> => abandonStudioInRegion(studioId),
  /**
   * Send this Studio's whole state to the directory, to repair its row.
   * @param studioId - A Studio in this region.
   * @returns Whether this region holds the Studio, so a snapshot went into the outbox.
   */
  emitStudioSnapshot: (studioId: string): Promise<boolean> => emitStudioSnapshot(studioId),
};

/**
 * Whether a region code names a region this deployment can place Studios in.
 * @param region - The code.
 * @returns True for the global region and every region with an address.
 */
export function isKnownRegion(region: string): boolean {
  return region === env.GLOBAL_REGION || Object.hasOwn(env.REGION_API_URLS, region);
}

/**
 * The global region's client for one region.
 * @param region - The region.
 * @returns Its calls; each fails when the region has no address or does not answer.
 */
export const regionClient: RegionClientFactory = (region: string): RegionClient => {
  const config = getRegionsConfig();
  return {
    probe: async () => {
      await callRegion(region, "probe", [], config.region_probe_timeout_ms);
    },
    createStudio: async (input) =>
      (await callRegion(region, "createStudio", [input], config.global_api_timeout_ms)) as "created" | "exists" | "abandoned",
    abandonStudio: async (studioId) =>
      (await callRegion(region, "abandonStudio", [studioId], config.global_api_timeout_ms)) as "exists" | "abandoned",
  };
};
