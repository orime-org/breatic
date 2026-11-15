// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The global functions server and worker call (inner#1955). In the global
 * region each runs in process; elsewhere each is a signed call to the global
 * region's internal API, which runs the same function there
 * (`packages/server/src/routes/internal/global.ts`).
 */

import {
  checkSessions,
  claimFirstMilestone,
  createGlobalApi,
  db,
  enqueueAccountAdsConversion,
  getLimitsForStudio,
  getRedis,
  type ActivityCursor,
  type FirstMilestone,
  type MembershipLimits,
} from "@breatic/core";
import { listLedgerByStudio, type StudioLedgerRow } from "@domain/credit/creditLot.repo.js";
import { lookupKeysHere, type KeyLookupAnswer } from "@domain/asset/asset-key-lookup.js";
import type { CreditDecimal, ProjectCreditsView } from "@breatic/shared";
import * as usersRepo from "@domain/auth/user.repo.js";
import {
  changeDirectoryAdmin,
  getProfiles,
  type AdminChange,
  type AdminChangeResult,
  type Profile,
} from "@domain/region/studioDirectory.service.js";
import { releaseSlug, reserveSlug } from "@domain/region/directory-writes.js";
import { applyRegionEvent } from "@domain/region/regionOutboxApply.service.js";
import { getStorageBudget, recordRegionUsage, type RegionUsageReport, type StorageBudget } from "@domain/region/storageUsage.service.js";
import type { OutboxEvent } from "@domain/region/regionOutbox.service.js";
import {
  grantedCreditsHere,
  hasActiveDesignationsTo,
  readStudioCreditsHere,
  spendableHere,
  studioDebtHere,
  unassignedCreditsHere,
  settleRegionalCharge,
  type StudioCreditsSnapshot,
  type RegionalChargeOutcome,
  type RegionalChargeRequest,
} from "@domain/credit/creditLot.service.js";
import { abandonHere, positionHere, releaseHere, reserveHere, type HoldFields, type ReserveOutcome } from "@domain/credit/creditHold.service.js";

/** An account as other regions read it. */
export interface Account {
  id: string;
  email: string;
  emailVerified: boolean;
  locale: string;
}

/**
 * The account fields other regions read.
 * @param user - The account.
 * @param user.id - Its id.
 * @param user.email - Its address.
 * @param user.emailVerified - Whether the address is proven.
 * @param user.locale - Its language.
 * @returns Those fields.
 */
function accountOf(user: { id: string; email: string; emailVerified: boolean; locale: string }): Account {
  return { id: user.id, email: user.email, emailVerified: user.emailVerified, locale: user.locale };
}

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
   * Give up a hold whose reserve call failed, so a late reserve holds nothing.
   * @param hold - The hold's Studio, actor and key.
   * @param hold.studioId - The Studio.
   * @param hold.actorUserId - Who started the work.
   * @param hold.referenceId - Its key.
   * @returns Once given up.
   */
  abandonHold: (hold: { studioId: string; actorUserId: string; referenceId: string }): Promise<void> => abandonHere(hold),
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
  getSpendableCredits: async (studioId: string): Promise<string> => String(await spendableHere(studioId)),
  /**
   * What a Studio owes, for explaining a refused run.
   * @param studioId - The Studio.
   * @returns The debt in credits.
   */
  getStudioDebt: (studioId: string): Promise<CreditDecimal> => studioDebtHere(studioId),
  /**
   * What an account holds that no Studio can spend yet, for explaining a refused run.
   * @param userId - The account.
   * @returns The total in credits.
   */
  getUnassignedCredits: (userId: string): Promise<CreditDecimal> => unassignedCreditsHere(userId),
  /**
   * What an account was granted rather than bought, for explaining a refused run.
   * @param userId - The account.
   * @returns The total in credits.
   */
  getGrantedCredits: (userId: string): Promise<CreditDecimal> => grantedCreditsHere(userId),
  /**
   * A Studio's credits page from one snapshot, for its admin in the Studio's region.
   * @param studioId - The Studio.
   * @param limit - How many ledger lines to take.
   * @returns The figures, the designated lots and the first ledger lines.
   */
  readStudioCredits: (studioId: string, limit: number): Promise<StudioCreditsSnapshot> => readStudioCreditsHere(studioId, limit),
  /**
   * A later page of a Studio's ledger.
   * @param studioId - The Studio.
   * @param limit - How many lines to take.
   * @param cursor - The previous page's last line.
   * @returns The page, newest first.
   */
  listStudioLedger: (studioId: string, limit: number, cursor: ActivityCursor): Promise<StudioLedgerRow[]> =>
    listLedgerByStudio(studioId, limit, cursor),
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
  /**
   * The ceilings that apply to a Studio: its current admin's membership's.
   * @param studioId - The Studio.
   * @returns Its six ceilings.
   */
  getLimitsForStudio: (studioId: string): Promise<MembershipLimits> => getLimitsForStudio(studioId),
  /**
   * Claim an account's first milestone of a kind, once across every region.
   * @param kind - Which milestone.
   * @param userId - The account.
   * @returns Whether this call claimed it.
   */
  claimAccountMilestone: async (kind: FirstMilestone, userId: string): Promise<{ claimed: boolean }> => ({
    claimed: await claimFirstMilestone(kind, userId),
  }),
  /**
   * How each of these users is shown.
   * @param userIds - The users.
   * @returns Each known user's profile.
   */
  getProfiles: (userIds: string[]): Promise<Record<string, Profile>> => getProfiles(userIds),
  /**
   * The accounts behind these ids.
   * @param userIds - The users.
   * @returns Every live account among them.
   */
  getAccounts: async (userIds: string[]): Promise<Account[]> => (await usersRepo.getUsersByIds(userIds)).map(accountOf),
  /**
   * The live account registered under an address, in any casing.
   * @param email - The address.
   * @returns The account, or null.
   */
  findAccountByEmail: async (email: string): Promise<Account | null> => {
    const user = await usersRepo.getUserByEmail(email);
    return user === null ? null : accountOf(user);
  },
  /**
   * The Agent model an account last chose.
   * @param userId - The account.
   * @returns The model id, or null when none was chosen.
   */
  getAgentModel: (userId: string): Promise<string | null> => usersRepo.getAgentModel(userId),
  /**
   * Remember the Agent model an account chose.
   * @param userId - The account.
   * @param model - The model id.
   * @returns Once saved.
   */
  setAgentModel: (userId: string, model: string): Promise<void> => usersRepo.setAgentModel(userId, model),
  /**
   * A Studio admin's storage ceiling and what the admin's Studios use outside the calling region.
   * @param studioId - The Studio.
   * @param callerRegion - The calling region.
   * @returns The budget.
   */
  getStorageBudget: (studioId: string, callerRegion: string): Promise<StorageBudget> => getStorageBudget(studioId, callerRegion),
  /**
   * Record what a region's Studios use.
   * @param report - The region's report.
   * @returns Once recorded.
   */
  recordRegionUsage: (report: RegionUsageReport): Promise<void> => recordRegionUsage(report),
  /**
   * What the global region's ledger holds under a paste's storage keys, for a paste in another region.
   * @param keys - The keys.
   * @returns Each key's live row and cover row.
   */
  findAssetsByKeys: (keys: string[]): Promise<Record<string, KeyLookupAnswer>> => lookupKeysHere(keys),
  /** Queue an account's ad conversion, credited to its sign-up click; core's own client calls the same. */
  enqueueAdsConversion: enqueueAccountAdsConversion,
};

/** The global functions' API. */
export type GlobalApi = typeof GLOBAL_FUNCTIONS;

let api: GlobalApi | null = null;

/**
 * The global functions for this process, built on first use.
 * @returns In process in the global region, signed requests elsewhere.
 */
export function globalApi(): GlobalApi {
  api ??= createGlobalApi(GLOBAL_FUNCTIONS);
  return api;
}

