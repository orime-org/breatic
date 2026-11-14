// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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

import { profilesService, studioRepo } from "@breatic/domain";
import * as studioInvitationsRepo from "@server/modules/studio/studioInvitations.repo.js";
import { withPendingDisplay } from "@server/modules/invitation/pending-display.js";
import { isUniqueViolation, inGlobalRegion } from "@breatic/core";
import { randomUUID } from "node:crypto";
import { db, studioDirectoryRepo } from "@breatic/core";
import { ConflictError, NotFoundError, ValidationError } from "@breatic/core";
import { env } from "@breatic/core";
import {
  directoryWrites,
  globalApi,
  isKnownRegion,
  regionClient,
  studioAuthService,
  studioCreationService,
  studioMembersRepo,
} from "@breatic/domain";
import { getTrialGrantCredits } from "@server/config/pricing.js";
import {
  t,
  SLUG_REGEX,
  RESERVED_STUDIO_SLUGS,
  STUDIO_SLUG_BOUNDS,
} from "@breatic/shared";
import type {
  Studio,
  StudioDetail,
  StudioMembersView,
  StudioRole,
  StudioSummary,
} from "@breatic/shared";


/**
 * Create the user's personal studio with the slug they chose at onboarding,
 * in the region the page placed it (inner#1955), with its trial credits.
 *
 * `slug = name = slug` and `type = 'personal'`; the slug's format is
 * validated by the route (`setupStudioSchema`). The global directory decides
 * whether the slug is free and keeps one personal Studio per user, in every
 * region (`studioCreationService.createStudio`).
 * @param userId - The authenticated user's UUID (becomes the studio creator + admin)
 * @param slug - The validated, lowercased URL handle the user chose
 * @param placement - The page's Studio id and region.
 * @returns The freshly created personal studio
 * @throws {ConflictError} `slug_taken`, `studio_creation_in_progress` or `studio_creation_abandoned`
 * @throws {AppError} 503 `region_unavailable`
 * @throws {ValidationError} the deployment has no such region
 */
export async function createPersonalStudio(
  userId: string,
  slug: string,
  placement: StudioPlacement = {},
): Promise<Studio> {
  return studioCreationService.createStudio(
    {
      studioId: placement.studioId ?? randomUUID(),
      userId,
      type: "personal",
      slug,
      name: slug,
      region: placementRegion(placement.region),
    },
    // How many to give is read here because the file it comes from is this
    // package's to read. The read itself is behind the same flag the grant
    // checks: a deployment that charges nobody has no `config/pricing.yaml`
    // to open.
    { regionClient, trialCredits: env.PAYMENT_ENABLED ? getTrialGrantCredits() : 0 },
  );
}



/**
 * Create a team studio in the region the page placed it (inner#1955). The
 * creator becomes its admin. The team quota counts the user's team Studios in
 * every region, live and still being created, under the account lock, so two
 * requests arriving together cannot both take the last place.
 * @param userId - The authenticated user's UUID (becomes the studio admin)
 * @param name - The display name (independent of the slug)
 * @param slug - The validated, globally-unique URL handle
 * @param placement - The page's Studio id and region.
 * @returns The freshly created team studio
 * @throws {ConflictError} `slug_taken`, `team_limit_reached`,
 *   `studio_creation_in_progress` or `studio_creation_abandoned`
 * @throws {AppError} 503 `region_unavailable`
 * @throws {ValidationError} the deployment has no such region
 */
export async function createTeamStudio(
  userId: string,
  name: string,
  slug: string,
  placement: StudioPlacement = {},
): Promise<Studio> {
  return studioCreationService.createStudio(
    {
      studioId: placement.studioId ?? randomUUID(),
      userId,
      type: "team",
      slug,
      name,
      region: placementRegion(placement.region),
    },
    { regionClient },
  );
}

/** Where the page asked a new Studio to go (inner#1955). */
export interface StudioPlacement {
  /** The id the page generated; one is generated here when absent. */
  studioId?: string;
  /** The region the user chose; absent means the global region. */
  region?: string;
}

/**
 * The region a new Studio goes to. A deployment with one region ignores
 * whatever the page sent; one with several takes only a region it has an
 * address for.
 * @param requested - The region the page sent.
 * @returns The region code.
 * @throws {ValidationError} When the deployment has no such region.
 */
function placementRegion(requested: string | undefined): string {
  if (requested === undefined || Object.keys(env.REGION_API_URLS).length === 0) return env.GLOBAL_REGION;
  if (!isKnownRegion(requested)) throw new ValidationError(t("server.error.validation"));
  return requested;
}

/**
 * Check whether a studio slug is available, for the live (debounced)
 * availability indicator in the create and rename forms.
 *
 * A UX helper only — it tells the user early what the write would say. The
 * authoritative guards are the schema (shape, length, reserved words) and the
 * `studios_slug_idx` unique index, so a slug reported available here can still
 * lose a concurrent race and surface as `409` on submit. Checks run in the
 * order the user would hit them, so the reason names the first real problem.
 *
 * `excludeStudioId` is what makes this usable while renaming: a studio's
 * current slug is held by itself, and without the exclusion the form would
 * report the admin's own handle as taken the moment they focus the field.
 * @param slug - The candidate slug to check
 * @param excludeStudioId - The studio being renamed, whose own claim on the
 *   slug does not count as taken; omit when creating
 * @returns `{ available: true }`, or `{ available: false, reason }` with the
 *   first failure (`format` / `length` / `reserved` / `taken`)
 */
export async function checkStudioSlug(
  slug: string,
  excludeStudioId?: string,
): Promise<{
  available: boolean;
  reason?: "format" | "length" | "reserved" | "taken";
}> {
  if (!SLUG_REGEX.test(slug)) {
    return { available: false, reason: "format" };
  }
  if (
    slug.length < STUDIO_SLUG_BOUNDS.min ||
    slug.length > STUDIO_SLUG_BOUNDS.max
  ) {
    return { available: false, reason: "length" };
  }
  if (RESERVED_STUDIO_SLUGS.has(slug)) {
    return { available: false, reason: "reserved" };
  }
  // Slugs are unique across regions, so the global directory answers.
  const taken = await studioDirectoryRepo.isSlugHeld(slug, undefined, excludeStudioId);
  return taken ? { available: false, reason: "taken" } : { available: true };
}

/**
 * Apply a settings patch to a studio — display name, slug, and/or bio.
 *
 * The route gates the caller as the studio's admin; this enforces what the
 * gate cannot. Absent fields are left untouched, so the form can send only
 * what changed. An empty-string bio clears it and is stored as `null`, so
 * "no bio" has exactly one representation in the column.
 *
 * Personal studios are editable here, unlike the membership operations that
 * refuse them: a personal studio's name, handle and bio ARE its owner's
 * profile. What a personal studio has no meaningful version of is being
 * transferred, left, or having members — not being renamed.
 *
 * Slug uniqueness is left to the `studios_slug_idx` unique index rather than a
 * pre-check: a pre-check races, the index does not. The violation is mapped to
 * a conflict so a lost race reads the same as a slug that was already taken.
 *
 * Changing the slug frees the old one immediately — no alias, no redirect
 * (rule 7). Every existing link to the old address stops working, which is why
 * a caller is expected to confirm it with the user first. Where that
 * confirmation lives is the frontend's business, not this layer's.
 * @param slug - The studio's CURRENT slug (from the URL)
 * @param patch - The fields to change; at least one must be present
 * @param patch.name - New display name
 * @param patch.slug - New URL handle
 * @param patch.bio - New bio; the empty string clears it
 * @returns The updated studio
 * @throws {NotFoundError} no active studio has that slug
 * @throws {ConflictError} the requested slug is already taken
 */
export async function updateStudio(
  slug: string,
  patch: { name?: string; slug?: string; bio?: string },
): Promise<Studio> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  const newSlug = patch.slug !== undefined && patch.slug !== studio.slug ? patch.slug : undefined;
  // Slugs are unique across regions (inner#1955). Outside the global region
  // the new slug is held there first and let go if the rename does not commit.
  const remote = !inGlobalRegion();
  if (newSlug !== undefined && remote && !(await globalApi().reserveSlug(newSlug, studio.id))) {
    throw new ConflictError(t("server.studio.slug_taken"));
  }
  try {
    return await db.transaction(async (tx) => {
      await studioRepo.lockStudio(studio.id, tx);
      if (newSlug !== undefined && !remote && !(await directoryWrites.slugFreeHere(newSlug, tx))) {
        throw new ConflictError(t("server.studio.slug_taken"));
      }
      const updated = await studioRepo.updateStudio(studio.id, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        ...(patch.bio !== undefined ? { bio: patch.bio === "" ? null : patch.bio } : {}),
      });
      if (!updated) {
        throw new NotFoundError(t("server.error.not_found"));
      }
      const changed = {
        ...(patch.name !== undefined && patch.name !== studio.name ? { name: patch.name } : {}),
        ...(newSlug !== undefined ? { slug: newSlug } : {}),
      };
      if (Object.keys(changed).length > 0) await directoryWrites.profileChanged(studio.id, changed, tx);
      return updated;
    });
  } catch (err) {
    if (newSlug !== undefined && remote) {
      await globalApi().releaseSlug(newSlug, studio.id).catch(() => undefined);
    }
    if (isUniqueViolation(err)) {
      throw new ConflictError(t("server.studio.slug_taken"));
    }
    throw err;
  }
}

/**
 * Look up a user's personal studio without creating one, from the global
 * directory, which holds it whichever region the Studio lives in
 * (inner#1955). Served by the global region's sign-in and `/auth/me`.
 *
 * Returns `null` when the user has registered but not yet completed the
 * slug-setup step. Callers that require a studio to exist (project
 * creation, the `/auth/me` onboarding gate) treat `null` as "needs
 * onboarding".
 * @param userId - User UUID
 * @returns The user's personal studio, or `null` if none exists
 */
export async function getPersonalStudio(
  userId: string,
): Promise<{ id: string; name: string; slug: string; avatarUrl: string | null } | null> {
  const row = await studioDirectoryRepo.findPersonalByCreator(userId);
  return row === null ? null : { id: row.studioId, name: row.name, slug: row.slug, avatarUrl: row.avatarUrl };
}

/**
 * Resolve a studio by its URL slug, or `null` if no active studio has it.
 *
 * A thin lookup used by callers that need the studio id behind a slug param
 * without the extra member-count / role joins `getStudioDetail` carries (e.g.
 * `project.service.listByStudioSlug`, which then lists the studio's projects
 * for the viewer).
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
    avatarUrl: studio.avatarUrl,
    bio: studio.bio,
    memberCount: counts.get(studio.id) ?? 0,
    myStudioRole,
    region: inGlobalRegion() ? null : env.REGION,
  };
}

/**
 * List every studio the user is an active member of, for the switcher, from
 * the global directory, which holds every region's Studios and names the
 * region of each (inner#1955); the bio comes from the studios this region
 * holds.
 *
 * The user's personal studio is always returned first; the remaining
 * studios follow in creation order (the repo orders by `created_at`, and
 * `Array.prototype.sort` is stable, so equal-type entries keep that order).
 * @param userId - The authenticated user's UUID
 * @returns The user's studios as summaries, personal-first
 */
export async function listUserStudios(
  userId: string,
): Promise<StudioSummary[]> {
  const [rows, local] = await Promise.all([
    studioDirectoryRepo.listStudiosOfUser(userId),
    studioRepo.listByUser(userId),
  ]);
  const bios = new Map(local.map((s) => [s.id, s.bio]));
  const summaries: StudioSummary[] = rows.map((row) => ({
    id: row.studioId,
    slug: row.slug,
    name: row.name,
    type: row.type,
    avatarUrl: row.avatarUrl,
    bio: bios.get(row.studioId) ?? null,
    memberCount: row.memberCount,
    myStudioRole: row.role as StudioRole,
    region: row.region,
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
  // Who each member is comes from the global profiles (inner#1955); a member
  // whose account is gone is left out, and one with no personal Studio shows
  // their address.
  const profiles = await profilesService.profilesOf(rows.map((m) => m.userId));
  const members = rows.flatMap((m) => {
    const profile = profiles.get(m.userId);
    if (profile === undefined || profile.email === null) return [];
    const shown = profile.name !== null && !profile.deleted;
    return [{
      userId: m.userId,
      name: shown ? profile.name! : profile.email,
      email: profile.email,
      avatarUrl: shown ? profile.avatarUrl : null,
      role: m.role,
      addedAt: m.addedAt.toISOString(),
    }];
  });
  const viewerRole = await studioAuthService.loadStudioRole(
    viewerUserId,
    studio.id,
  );
  const pendingInvitations =
    viewerRole === "admin"
      ? await withPendingDisplay(await studioInvitationsRepo.listPendingByStudio(studio.id))
      : [];
  return { members, pendingInvitations };
}
