// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The global functions server and worker call (inner#1955). In the global
 * region each runs in process; elsewhere each is a signed call to the global
 * region's internal API, which runs the same function there
 * (`packages/server/src/routes/internal/global.ts`).
 */

import { checkSessions, createGlobalApi, db, env, getRedis, getRegionsConfig } from "@breatic/core";
import { changeDirectoryAdmin, type AdminChange, type AdminChangeResult } from "@domain/region/studioDirectory.service.js";
import { releaseSlug, reserveSlug } from "@domain/region/directory-writes.js";
import { applyRegionEvent } from "@domain/region/regionOutboxApply.service.js";
import type { OutboxEvent } from "@domain/region/regionOutbox.service.js";
import {
  getSpendableCredits,
  hasActiveDesignationsTo,
  settleRegionalCharge,
  type RegionalChargeOutcome,
  type RegionalChargeRequest,
} from "@domain/credit/creditLot.service.js";
import { positionHere, releaseHere, reserveHere, type HoldFields, type ReserveOutcome } from "@domain/credit/creditHold.service.js";
import type { ProjectCreditsView } from "@breatic/shared";

/** The global functions, as the global region runs them. */
export const GLOBAL_FUNCTIONS = {
  /**
   * Move a Studio's admin for an accepted transfer; the transfer id is the change id.
   * @param change - The transfer's Studio, admins and id.
   * @returns Whether the directory admin is now the recipient.
   */
  transferAdmin: (change: AdminChange): Promise<AdminChangeResult> => changeDirectoryAdmin(change),
  /**
   * Which of these session ids have ended, for a region's collab recheck.
   * @param sids - Session ids.
   * @returns The ended ones.
   */
  checkSessions: (sids: string[]): Promise<string[]> => checkSessions(getRedis(), sids),
  /**
   * Settle a region's charge request once per region and request id.
   * @param request - The region's request.
   * @returns What was charged, the first time and every time after.
   */
  settleCharge: (request: RegionalChargeRequest): Promise<RegionalChargeOutcome> => settleRegionalCharge(request),
  /**
   * Hold credits for work a region admits.
   * @param request - The hold, against its Studio.
   * @returns Admitted, or refused with the Studio's position.
   */
  reserveCredits: (request: HoldFields & { studioId: string }): Promise<ReserveOutcome> => reserveHere(request),
  /**
   * Release a hold a region took.
   * @param referenceId - The hold's key.
   * @returns Once released.
   */
  releaseHold: (referenceId: string): Promise<void> => releaseHere(referenceId),
  /**
   * A Studio's balance, holds and what is left, for a Project's top bar.
   * @param studioId - The Studio.
   * @returns Its position.
   */
  getCreditPosition: (studioId: string): Promise<ProjectCreditsView> => positionHere(studioId),
  /**
   * Whether any live purchase points at a Studio, before a region files its transfer offer.
   * @param studioId - The Studio.
   * @returns True when at least one does.
   */
  hasActiveDesignationsTo: (studioId: string): Promise<boolean> =>
    db.transaction((tx) => hasActiveDesignationsTo(studioId, tx)),
  /**
   * What a Studio can spend, for admitting a chat turn, a text-tool run or a Timeline execution.
   * @param studioId - The Studio.
   * @returns Its spendable credits.
   */
  getSpendableCredits: async (studioId: string): Promise<string> => String(await getSpendableCredits(studioId)),
  /**
   * Hold a new slug for a region's rename.
   * @param slug - The slug.
   * @param studioId - The Studio.
   * @returns Whether it is held for the Studio.
   */
  reserveSlug: (slug: string, studioId: string): Promise<boolean> => reserveSlug(slug, studioId),
  /**
   * Let go of a rename's reservation.
   * @param slug - The slug.
   * @param studioId - The Studio.
   * @returns Once released.
   */
  releaseSlug: (slug: string, studioId: string): Promise<void> => releaseSlug(slug, studioId),
  /**
   * Apply one event a region's outbox relay sent.
   * @param region - The sending region.
   * @param event - The event.
   * @returns `applied`, `duplicate` or `permanent_failure`.
   */
  applyRegionEvent: (region: string, event: OutboxEvent): Promise<"applied" | "duplicate" | "permanent_failure"> =>
    applyRegionEvent(region, event),
};

/** The global functions' API. */
export type GlobalApi = typeof GLOBAL_FUNCTIONS;

let api: GlobalApi | null = null;

/**
 * The global functions for this process, built on first use.
 * @returns In process in the global region, signed requests elsewhere.
 */
export function globalApi(): GlobalApi {
  api ??= createGlobalApi(GLOBAL_FUNCTIONS, {
    region: env.REGION,
    globalRegion: env.GLOBAL_REGION,
    globalApiUrl: env.GLOBAL_API_URL,
    secret: env.INTERNAL_API_SECRET,
    timeoutMs: getRegionsConfig().global_api_timeout_ms,
  });
  return api;
}

