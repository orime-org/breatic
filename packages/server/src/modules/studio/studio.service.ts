// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio service — personal studio lifecycle.
 *
 * Every user gets exactly one personal studio, created in the second
 * registration step (`POST /auth/setup-studio`): the user picks a slug,
 * and the studio is written with `slug = name = the chosen slug`,
 * `type = 'personal'`. The studio row + the creator's `admin`
 * `studio_members` row are written atomically (mirrors project + owner).
 *
 * A user's display name lives on their personal studio's `name` (the
 * `users` table no longer carries a `username` — email-registration
 * rewrite, 2026-06-06).
 *
 * Stays in `@server` for slice 1; the move to `@breatic/domain` (so the
 * worker can use it for billing_source) is deferred — just-in-time, when
 * a second consumer actually needs it.
 */

import * as studioRepo from "@server/modules/studio/studio.repo.js";
import { db } from "@breatic/core";
import { ConflictError, NotFoundError } from "@breatic/core";
import { studioMembersRepo, studioAuthService } from "@breatic/domain";
import { t } from "@breatic/shared";
import type {
  Studio,
  StudioDetail,
  StudioMemberSummary,
  StudioSummary,
} from "@breatic/shared";

/**
 * Detect a PostgreSQL unique-violation error (SQLSTATE 23505), walking the
 * `.cause` chain.
 *
 * Used to map a slug collision (lost the pre-check race) or a
 * second-personal-studio attempt to a typed `ConflictError` instead of a
 * raw 500. Inside a `db.transaction`, drizzle 0.45 wraps the driver error
 * in a `DrizzleQueryError` and hangs the original postgres error (carrying
 * `code: '23505'`) on `.cause` — so a flat `err.code` check is not enough;
 * we walk the cause chain.
 * @param err - Caught error of unknown shape
 * @returns True if any error in the cause chain carries the `23505` SQLSTATE code
 */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (
      typeof cur === "object" &&
      "code" in cur &&
      (cur as { code: unknown }).code === "23505"
    ) {
      return true;
    }
    cur = typeof cur === "object" && "cause" in cur
      ? (cur as { cause: unknown }).cause
      : null;
  }
  return false;
}

/**
 * Create the user's personal studio with the slug they chose at
 * onboarding, plus the creator's admin `studio_members` row, atomically.
 *
 * `slug = name = slug` and `type = 'personal'`. The slug's format must
 * already be validated by the caller (route layer via `setupStudioSchema`)
 * and uniqueness pre-checked; this method still wraps the insert so a
 * concurrent duplicate slug (lost the pre-check race) surfaces as a typed
 * `ConflictError` instead of a raw 500. Both the global-unique slug index
 * (`studios_slug_idx`) and the one-personal-per-user index
 * (`studios_owner_personal_idx`) back the conflict.
 * @param userId - The authenticated user's UUID (becomes the studio creator + admin)
 * @param slug - The validated, lowercased URL handle the user chose
 * @returns The freshly created personal studio
 * @throws {ConflictError} if the slug is already taken, or the user
 *   already has a personal studio (unique-index violation)
 */
export async function createPersonalStudio(
  userId: string,
  slug: string,
): Promise<Studio> {
  try {
    return await db.transaction(async (tx) => {
      const studio = await studioRepo.createPersonalStudio(userId, slug, slug, tx);
      await studioMembersRepo.insertAdmin(studio.id, userId, tx);
      return studio;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(t("server.studio.slug_taken"));
    }
    throw err;
  }
}

/**
 * Look up a user's personal studio without creating one.
 *
 * Returns `null` when the user has registered but not yet completed the
 * slug-setup step. Callers that require a studio to exist (project
 * creation, the `/auth/me` onboarding gate) treat `null` as "needs
 * onboarding".
 * @param userId - User UUID
 * @returns The user's personal studio, or `null` if none exists
 */
export async function getPersonalStudio(userId: string): Promise<Studio | null> {
  return studioRepo.getPersonalByCreator(userId);
}

/**
 * Resolve the display `name` of each user's personal studio in one query.
 *
 * Backs the display-name source for `/users` batch lookup and invite
 * `inviterName` now that the name no longer lives on `users`. Users
 * without a personal studio (mid-onboarding) are simply absent from the
 * returned map; callers fall back to the email local-part.
 * @param userIds - User UUIDs to resolve (deduped + capped by the caller)
 * @returns Map of `userId → personal studio name` (missing for users with no studio)
 */
export async function getPersonalStudioNamesByUserIds(
  userIds: string[],
): Promise<Map<string, string>> {
  return studioRepo.getPersonalNamesByCreators(userIds);
}

/**
 * Resolve a studio by its URL slug, or `null` if no active studio has it.
 *
 * A thin lookup used by callers that need the studio id behind a slug param
 * without the extra member-count / role joins `getStudioDetail` carries (e.g.
 * `project.service.listByStudioSlug`, which then applies its own
 * visibility-aware project filter).
 * @param slug - The studio's URL handle
 * @returns The studio, or `null` when no active studio has that slug
 */
export async function getStudioBySlug(slug: string): Promise<Studio | null> {
  return studioRepo.getBySlug(slug);
}

/**
 * Resolve one studio's public-facing shell by slug, for the container page.
 *
 * The shell is visible to **any** authenticated user (decision A — a
 * studio's `/studio/{slug}` page is its front door, like a profile page):
 * a non-member gets a `200` with `myStudioRole: null` (a guest), NOT a
 * `403`. Private content inside the studio's tabs is gated by role in later
 * slices. `memberCount` is the active member count (a personal studio has
 * 1: its creator/admin).
 * @param slug - The studio's URL handle
 * @param userId - The viewing user's UUID (resolves their role on this studio)
 * @returns The studio detail, with the viewer's role (`null` = guest)
 * @throws {NotFoundError} when no active studio has that slug
 */
export async function getStudioDetail(
  slug: string,
  userId: string,
): Promise<StudioDetail> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  const counts = await studioRepo.countMembersByStudioIds([studio.id]);
  const myStudioRole = await studioAuthService.loadStudioRole(userId, studio.id);
  return {
    id: studio.id,
    slug: studio.slug,
    name: studio.name,
    type: studio.type,
    memberCount: counts.get(studio.id) ?? 0,
    myStudioRole,
  };
}

/**
 * List every studio the user is an active member of, for the switcher.
 *
 * The user's personal studio is always returned first; the remaining
 * studios follow in creation order (the repo orders by `created_at`, and
 * `Array.prototype.sort` is stable, so equal-type entries keep that order).
 * `memberCount` is resolved in a single grouped query (no N+1).
 * @param userId - The authenticated user's UUID
 * @returns The user's studios as summaries, personal-first
 */
export async function listUserStudios(
  userId: string,
): Promise<StudioSummary[]> {
  const userStudios = await studioRepo.listByUser(userId);
  if (userStudios.length === 0) return [];
  const counts = await studioRepo.countMembersByStudioIds(
    userStudios.map((s) => s.id),
  );
  const summaries: StudioSummary[] = userStudios.map((s) => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    type: s.type,
    memberCount: counts.get(s.id) ?? 0,
    myStudioRole: s.myStudioRole,
  }));
  return summaries.sort((a, b) =>
    a.type === b.type ? 0 : a.type === "personal" ? -1 : 1,
  );
}

/**
 * List a studio's active members for the Members tab (display name / email /
 * avatar / role / join date), resolved by slug.
 *
 * The studio-shell decision A applies — visible to any authenticated user, but
 * only members' tabs call this (a non-member sees no Members tab). Each
 * member's display `name` comes from their personal studio (the `users` table
 * has no username). A personal studio returns exactly its admin (the creator).
 * @param slug - The studio's URL handle
 * @returns The active members, oldest-first (admin/creator at the top)
 * @throws {NotFoundError} when no active studio has that slug
 */
export async function getStudioMembers(
  slug: string,
): Promise<StudioMemberSummary[]> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  const members = await studioMembersRepo.listByStudio(studio.id);
  return members.map((m) => ({
    userId: m.userId,
    name: m.name,
    email: m.email,
    avatarUrl: m.avatarUrl,
    role: m.role,
    addedAt: m.addedAt.toISOString(),
  }));
}
