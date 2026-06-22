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
import * as studioInvitationsRepo from "@server/modules/studio/studioInvitations.repo.js";
import { isUniqueViolation } from "@server/utils/pg-error.js";
import { db } from "@breatic/core";
import { ConflictError, NotFoundError } from "@breatic/core";
import { studioMembersRepo, studioAuthService } from "@breatic/domain";
import { t, SLUG_REGEX } from "@breatic/shared";
import type {
  Studio,
  StudioDetail,
  StudioMembersView,
  StudioSummary,
} from "@breatic/shared";

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

/** Per-user cap on active team studios (user decision B, 2026-06-09). */
const TEAM_STUDIO_LIMIT = 50;

/**
 * Create a team studio with the creator as its sole admin, atomically.
 *
 * Unlike a personal studio, a user may own up to `TEAM_STUDIO_LIMIT` active
 * team studios. The studio row + the creator's admin `studio_members` row are
 * written in one transaction (mirrors `createPersonalStudio`); the per-user
 * limit is checked inside the same transaction. The limit is a soft cap —
 * concurrent creates may marginally exceed it, which is acceptable for a
 * non-integrity guard (the hard data-integrity invariant is the global-unique
 * slug, backed by `studios_slug_idx`). A taken slug (lost the unique-index
 * race) surfaces as a typed `ConflictError`.
 * @param userId - The authenticated user's UUID (becomes the studio admin)
 * @param name - The display name (independent of the slug)
 * @param slug - The validated, globally-unique URL handle
 * @returns The freshly created team studio
 * @throws {ConflictError} if the slug is already taken, or the user has
 *   reached the per-user team-studio limit
 */
export async function createTeamStudio(
  userId: string,
  name: string,
  slug: string,
): Promise<Studio> {
  try {
    return await db.transaction(async (tx) => {
      const count = await studioRepo.countTeamStudiosAdministeredBy(userId, tx);
      if (count >= TEAM_STUDIO_LIMIT) {
        throw new ConflictError(t("server.studio.team_limit_reached"));
      }
      const studio = await studioRepo.createTeamStudio(userId, slug, name, tx);
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
 * Check whether a studio slug is available, for the create dialog's live
 * (debounced) availability indicator.
 *
 * A UX helper only — the authoritative uniqueness guard is the
 * `studios_slug_idx` unique index enforced at insert time (so a slug reported
 * available here can still lose a concurrent race and surface as `409` on
 * submit). Format + length are validated first so the caller gets a precise
 * reason; reserved-word hardening is deferred to slice 7 (the frontend stub
 * list blocks the obvious ones meanwhile).
 * @param slug - The candidate slug to check
 * @returns `{ available: true }`, or `{ available: false, reason }` with the
 *   first failure (`format` / `length` / `taken`)
 */
export async function checkStudioSlug(
  slug: string,
): Promise<{ available: boolean; reason?: "format" | "length" | "taken" }> {
  if (!SLUG_REGEX.test(slug)) {
    return { available: false, reason: "format" };
  }
  if (slug.length < 6 || slug.length > 39) {
    return { available: false, reason: "length" };
  }
  const existing = await studioRepo.getBySlug(slug);
  return existing ? { available: false, reason: "taken" } : { available: true };
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
 * Resolve the display `name` + URL `slug` (handle) of each user's personal
 * studio in one query.
 *
 * The bell notification actor-identity source: the slug is the `@handle` shown
 * beside the name and the `/studio/{slug}` link target. Users mid-onboarding
 * (no personal studio) are absent from the map; callers fall back.
 * @param userIds - User UUIDs to resolve (deduped + capped by the caller)
 * @returns Map of `userId → { name, slug }` (missing for users with no studio)
 */
export async function getPersonalStudioProfilesByUserIds(
  userIds: string[],
): Promise<Map<string, { name: string; slug: string }>> {
  return studioRepo.getPersonalProfilesByCreators(userIds);
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
 * a non-member gets a `200` with `myStudioRole: null`, NOT a
 * `403`. Private content inside the studio's tabs is gated by role in later
 * slices. `memberCount` is the active member count (a personal studio has
 * 1: its creator/admin).
 * @param slug - The studio's URL handle
 * @param userId - The viewing user's UUID (resolves their role on this studio)
 * @returns The studio detail, with the viewer's role (`null` = non-member)
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
 * List a studio's Members-tab view, resolved by slug: the active members plus,
 * for an ADMIN viewer, the in-flight pending invitations.
 *
 * The studio-shell decision A applies — visible to any authenticated user, but
 * only members' tabs call this. Each member's display `name` comes from their
 * personal studio (the `users` table has no username). Pending invitations are
 * returned ONLY to an admin viewer (they carry the invitee's email — not leaked
 * to non-admins); every other viewer gets an empty `pendingInvitations`.
 * @param slug - The studio's URL handle
 * @param viewerUserId - The viewing user (their role gates pending visibility)
 * @returns Active members (oldest-first) + pending invitations (admins only)
 * @throws {NotFoundError} when no active studio has that slug
 */
export async function getStudioMembers(
  slug: string,
  viewerUserId: string,
): Promise<StudioMembersView> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  const rows = await studioMembersRepo.listByStudio(studio.id);
  const members = rows.map((m) => ({
    userId: m.userId,
    name: m.name,
    email: m.email,
    avatarUrl: m.avatarUrl,
    role: m.role,
    addedAt: m.addedAt.toISOString(),
  }));
  const viewerRole = await studioAuthService.loadStudioRole(
    viewerUserId,
    studio.id,
  );
  const pendingInvitations =
    viewerRole === "admin"
      ? await studioInvitationsRepo.listPendingByStudio(studio.id)
      : [];
  return { members, pendingInvitations };
}
