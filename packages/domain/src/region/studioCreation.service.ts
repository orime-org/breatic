// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Creating a Studio in whichever region the user chose (inner#1955), run by
 * the global region, which alone knows every slug and every quota.
 *
 * A Studio for the global region is written in one transaction, with its
 * live directory row. A Studio for another region takes a pending directory
 * row first: a semantic lock that holds the slug and counts toward the quota
 * like a live row, so nothing else can claim them while the region writes the
 * Studio. The row turns live once the region has written it; a creation the
 * request could not finish is finished or given up by the sweep.
 */

import {
  AppError,
  ConflictError,
  db,
  env,
  isUniqueViolation,
  lockLimitsForUser,
  studioDirectoryRepo,
  type DbTx,
  type DirectoryRow,
} from "@breatic/core";
import { t, type Studio } from "@breatic/shared";
import * as studioMembersRepo from "@domain/auth/studioMembers.repo.js";
import { grantTrialCredits } from "@domain/credit/creditLot.service.js";
import type { RegionStudioInput } from "@domain/region/studioRegion.service.js";
import * as studioRepo from "@domain/studio/studio.repo.js";

/** The calls the global region makes to the region a Studio is created in. */
export interface RegionClient {
  /** Answers when the region can be reached. */
  probe(): Promise<void>;
  createStudio(input: RegionStudioInput): Promise<"created" | "exists" | "abandoned">;
  abandonStudio(studioId: string): Promise<"exists" | "abandoned">;
}

/** Builds the client for one region. */
export type RegionClientFactory = (region: string) => RegionClient;

/** What a user asked to create. */
export interface CreateStudioInput {
  /** Chosen by the page, and kept while the form is unchanged, so a retry is the same creation. */
  studioId: string;
  userId: string;
  type: "personal" | "team";
  slug: string;
  name: string;
  /** The region to place it in. */
  region: string;
}

/** What a creation needs from its caller. */
export interface CreateStudioOptions {
  regionClient: RegionClientFactory;
  /** The trial credits a new personal Studio is given; zero gives none. */
  trialCredits?: number;
}

/** The refusal reasons a creation answers with. */
export const STUDIO_CREATION_REASONS = {
  regionUnavailable: "region_unavailable",
  slugTaken: "slug_taken",
  teamLimitReached: "team_limit_reached",
  inProgress: "studio_creation_in_progress",
  abandoned: "studio_creation_abandoned",
} as const;

/**
 * The refusal for a creation still waiting on its region.
 * @param cause - The failure that left it waiting, if there was one.
 * @returns The error.
 */
function inProgress(cause?: unknown): ConflictError {
  return new ConflictError(t("server.studio.creation_in_progress"), STUDIO_CREATION_REASONS.inProgress, { cause });
}

/**
 * The refusal for a creation the region already gave up.
 * @returns The error.
 */
function abandonedError(): ConflictError {
  return new ConflictError(t("server.studio.creation_abandoned"), STUDIO_CREATION_REASONS.abandoned);
}

/**
 * A Studio as the directory knows it.
 * @param row - The directory row.
 * @returns The Studio.
 */
function fromDirectory(row: DirectoryRow): Studio {
  const now = new Date();
  return {
    id: row.studioId,
    createdByUserId: row.createdByUserId,
    slug: row.slug,
    type: row.type,
    name: row.name,
    avatarUrl: row.avatarUrl,
    bio: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

/**
 * Whether a directory row is this very creation.
 * @param row - The row.
 * @param input - The creation.
 * @param region - Where it is placed, null for the global region.
 * @returns True when every field the user chose matches.
 */
function sameCreation(row: DirectoryRow, input: CreateStudioInput, region: string | null): boolean {
  return (
    row.createdByUserId === input.userId &&
    row.region === region &&
    row.slug === input.slug &&
    row.name === input.name &&
    row.type === input.type
  );
}

/**
 * Create a Studio where the user chose (design steps 1–5).
 * @param input - What to create, and where.
 * @param options - How to reach regions, and the trial credits of a personal Studio.
 * @returns The Studio.
 * @throws {AppError} 503 `region_unavailable` when the region cannot be reached.
 * @throws {ConflictError} `slug_taken`, `team_limit_reached`,
 *   `studio_creation_in_progress` or `studio_creation_abandoned`.
 */
export async function createStudio(input: CreateStudioInput, options: CreateStudioOptions): Promise<Studio> {
  const region = input.region === env.GLOBAL_REGION ? null : input.region;
  if (region === null) return slugConflictsAsTaken(() => createHere(input, options));

  const client = options.regionClient(region);
  try {
    await client.probe();
  } catch (err) {
    throw new AppError(503, t("server.studio.region_unavailable"), STUDIO_CREATION_REASONS.regionUnavailable, { cause: err });
  }

  const reserved = await slugConflictsAsTaken(() => db.transaction(async (tx) => reserve(input, region, tx)));
  if (reserved.state === "live") return fromDirectory(reserved);

  let answer: "created" | "exists" | "abandoned";
  try {
    answer = await client.createStudio({
      studioId: input.studioId,
      slug: input.slug,
      name: input.name,
      type: input.type,
      adminUserId: input.userId,
    });
  } catch (err) {
    throw inProgress(err);
  }
  if (answer === "abandoned") {
    await db.transaction((tx) => studioDirectoryRepo.abandonPending(input.studioId, tx));
    throw abandonedError();
  }
  return finish(input.studioId, options.trialCredits ?? 0);
}

/**
 * Answer a write that lost a uniqueness race as `slug_taken`: two requests
 * that both passed the checks, for one slug or for a second personal Studio,
 * meet at the directory's unique indexes.
 * @param write - The write.
 * @returns What it returned.
 * @throws {ConflictError} `slug_taken` on a unique violation; anything else unchanged.
 */
async function slugConflictsAsTaken<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(t("server.studio.slug_taken"), STUDIO_CREATION_REASONS.slugTaken);
    }
    throw err;
  }
}

/**
 * Lock the account and take the pending row (design step 2).
 * @param input - The creation.
 * @param region - The region it goes to.
 * @param tx - The transaction holding the account lock.
 * @returns The directory row: live when the sweep already finished this creation.
 * @throws {ConflictError} as {@link createStudio} documents.
 */
async function reserve(input: CreateStudioInput, region: string, tx: DbTx): Promise<DirectoryRow> {
  const { team_studios: limit } = await lockLimitsForUser(input.userId, tx);
  const existing = await studioDirectoryRepo.findAny(input.studioId, tx);
  if (existing !== null) {
    if (existing.deletedAt !== null) throw abandonedError();
    if (existing.state === "live" && sameCreation(existing, input, region)) return existing;
  }
  const pending = await studioDirectoryRepo.findPendingByCreator(input.userId, tx);
  if (pending !== null) {
    if (pending.studioId === input.studioId && sameCreation(pending, input, region)) return pending;
    throw inProgress();
  }
  await claimSlotAndSlug(input, limit, tx);
  await studioDirectoryRepo.insertRow(
    {
      studioId: input.studioId,
      slug: input.slug,
      region,
      type: input.type,
      name: input.name,
      adminUserId: input.userId,
      createdByUserId: input.userId,
      state: "pending",
    },
    tx,
  );
  return (await studioDirectoryRepo.findAny(input.studioId, tx))!;
}

/**
 * Refuse a creation over the team quota or onto a held slug.
 * @param input - The creation.
 * @param limit - The user's team Studio quota.
 * @param tx - The transaction holding the account lock.
 * @throws {ConflictError} `team_limit_reached` or `slug_taken`.
 */
async function claimSlotAndSlug(input: CreateStudioInput, limit: number, tx: DbTx): Promise<void> {
  if (input.type === "team" && (await studioDirectoryRepo.countTeamQuota(input.userId, tx)) >= limit) {
    throw new ConflictError(t("server.studio.team_limit_reached", { limit }), STUDIO_CREATION_REASONS.teamLimitReached);
  }
  await studioDirectoryRepo.lockSlug(input.slug, tx);
  if (await studioDirectoryRepo.isSlugHeld(input.slug, tx)) {
    throw new ConflictError(t("server.studio.slug_taken"), STUDIO_CREATION_REASONS.slugTaken);
  }
}

/**
 * Create a Studio in the global region: the Studio, its admin and its live
 * directory row in one transaction.
 * @param input - The creation.
 * @param options - The trial credits of a personal Studio.
 * @returns The Studio.
 * @throws {ConflictError} `slug_taken` or `team_limit_reached`.
 */
async function createHere(input: CreateStudioInput, options: CreateStudioOptions): Promise<Studio> {
  return db.transaction(async (tx) => {
    const { team_studios: limit } = await lockLimitsForUser(input.userId, tx);
    if ((await studioDirectoryRepo.findPendingByCreator(input.userId, tx)) !== null) throw inProgress();
    await claimSlotAndSlug(input, limit, tx);
    const studio =
      input.type === "personal"
        ? await studioRepo.createPersonalStudio(input.userId, input.slug, input.name, tx, input.studioId)
        : await studioRepo.createTeamStudio(input.userId, input.slug, input.name, tx, input.studioId);
    await studioMembersRepo.insertAdmin(studio.id, input.userId, tx);
    await studioDirectoryRepo.insertRow(
      {
        studioId: studio.id,
        slug: input.slug,
        region: null,
        type: input.type,
        name: input.name,
        adminUserId: input.userId,
        createdByUserId: input.userId,
        state: "live",
      },
      tx,
    );
    await studioDirectoryRepo.upsertMember(studio.id, input.userId, "admin", tx);
    if (input.type === "personal") {
      await grantTrialCredits({ userId: input.userId, studioId: studio.id, credits: options.trialCredits ?? 0 }, tx);
    }
    return studio;
  });
}

/**
 * Turn a pending row live once its region holds the Studio (design step 4):
 * the admin's directory membership, the region in their `user_regions`, and a
 * personal Studio's trial credits, pointed at it.
 * @param studioId - The Studio.
 * @param trialCredits - The trial credits of a personal Studio.
 * @returns The Studio.
 */
async function finish(studioId: string, trialCredits: number): Promise<Studio> {
  return db.transaction(async (tx) => {
    const row = await studioDirectoryRepo.lockRow(studioId, tx);
    if (row === null) throw abandonedError();
    if (await studioDirectoryRepo.markLive(studioId, tx)) {
      await studioDirectoryRepo.upsertMember(studioId, row.adminUserId, "admin", tx);
      if (row.region !== null) await studioDirectoryRepo.touchUserRegion(row.adminUserId, row.region, tx);
      if (row.type === "personal") {
        await grantTrialCredits({ userId: row.adminUserId, studioId, credits: trialCredits }, tx);
      }
    }
    return fromDirectory({ ...row, state: "live" });
  });
}

/**
 * Finish or give up creations left pending: each region is asked whether the
 * Studio landed, under the lock that decides it there.
 * @param options - How old a pending row must be, how to reach regions, and trial credits.
 * @param options.olderThanMs - Pending rows older than this are settled.
 * @param options.regionClient - The region client factory.
 * @param options.trialCredits - The trial credits of a personal Studio.
 * @returns How many rows were finished and given up, and each one whose region did not answer, with why.
 */
export async function sweepPendingStudios(options: {
  olderThanMs: number;
  regionClient: RegionClientFactory;
  trialCredits?: number;
}): Promise<{ finished: number; abandoned: number; unreachable: Array<{ studioId: string; region: string; err: unknown }> }> {
  const result = { finished: 0, abandoned: 0, unreachable: [] as Array<{ studioId: string; region: string; err: unknown }> };
  for (const row of await studioDirectoryRepo.listStalePending(options.olderThanMs)) {
    if (row.region === null) continue;
    let answer: "exists" | "abandoned";
    try {
      answer = await options.regionClient(row.region).abandonStudio(row.studioId);
    } catch (err) {
      result.unreachable.push({ studioId: row.studioId, region: row.region, err });
      continue;
    }
    if (answer === "exists") {
      await finish(row.studioId, options.trialCredits ?? 0);
      result.finished++;
    } else {
      await db.transaction((tx) => studioDirectoryRepo.abandonPending(row.studioId, tx));
      result.abandoned++;
    }
  }
  return result;
}

