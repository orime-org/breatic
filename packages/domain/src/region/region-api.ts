// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The calls between the global region and the other regions (inner#1955).
 *
 * `REGION_FUNCTIONS` is what a region serves at `/internal/region/<fn>`
 * (`packages/server/src/routes/internal/region.ts`); {@link regionClient} is
 * how the global region reaches one region's.
 */

import { callRegion, env, getRegionsConfig } from "@breatic/core";
import type { RegionClient, RegionClientFactory } from "@domain/region/studioCreation.service.js";
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
  const url = env.REGION_API_URLS[region];
  const config = getRegionsConfig();
  /**
   * Call one of the region's functions.
   * @param fn - The function.
   * @param args - Its arguments.
   * @param timeoutMs - How long to wait.
   * @returns The answer.
   * @throws {Error} When the region has no address.
   */
  const call = (fn: keyof typeof REGION_FUNCTIONS, args: unknown[], timeoutMs: number): Promise<unknown> => {
    if (url === undefined) return Promise.reject(new Error(`no address for region ${region}`));
    return callRegion(fn, args, { callerRegion: env.REGION, url, secret: env.INTERNAL_API_SECRET, timeoutMs });
  };
  return {
    probe: async () => {
      await call("probe", [], config.region_probe_timeout_ms);
    },
    createStudio: async (input) =>
      (await call("createStudio", [input], config.global_api_timeout_ms)) as "created" | "exists" | "abandoned",
    abandonStudio: async (studioId) =>
      (await call("abandonStudio", [studioId], config.global_api_timeout_ms)) as "exists" | "abandoned",
  };
};
