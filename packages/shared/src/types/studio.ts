// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio entity. A studio is either a `personal` studio (one per user,
 * created in the second onboarding step) or a `team` studio (created
 * explicitly). The studio's URL handle is its `slug`, chosen by the user
 * and globally unique. The display `name` is editable and is, for a
 * personal studio, the user's display name (initially equal to the slug).
 */

/** Studio kind. */
export type StudioType = "personal" | "team";

/**
 * Minimal personal-studio reference returned by the auth endpoints
 * (`/auth/me`, `/auth/setup-studio`). The frontend derives the user's
 * display name from `name` and links to `/studio/{slug}`. `null` on
 * `/auth/me` is the onboarding gate signal — the user has registered but
 * not yet picked a slug (email-registration rewrite, 2026-06-06).
 */
export interface PersonalStudioRef {
  name: string;
  slug: string;
}

/** Studio entity (personal or team). */
export interface Studio {
  id: string;
  /**
   * Creator — audit + the personal-studio uniqueness key. The admin role
   * lives in `studio_members`, so this is no longer an "owner" in the
   * permission sense; it just records who created the studio.
   */
  createdByUserId: string;
  /** URL handle — globally unique, chosen by the user at onboarding. */
  slug: string;
  type: StudioType;
  /** Display name (editable). */
  name: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Studio-level roles. Two role layers exist: studio Admin/Member (this
 * type) and project Owner/Editor/Viewer (`ProjectRole` in role.ts).
 *
 * One active admin per studio (enforced by a partial unique index on
 * `studio_members`); the creator is the admin. `member` is a plain
 * studio member.
 */
export type StudioRole = "admin" | "member";

/**
 * One row of the `studio_members` table — who has what studio-level role.
 *
 * `addedBy` is `null` for the creator's own admin row (no inviter); it
 * holds the inviter's user id for invited members.
 */
export interface StudioMember {
  studioId: string;
  userId: string;
  role: StudioRole;
  addedBy: string | null;
  addedAt: Date;
  deletedAt: Date | null;
}

/**
 * Studio summary — the minimal shape for switcher lists and cards, returned
 * by `GET /studios` (the current user's studios) and embedded in
 * `StudioDetail`. `memberCount` is the active member count (a personal
 * studio always has 1: its creator/admin). Whether to surface the count is
 * a frontend concern (personal studios hide it).
 */
export interface StudioSummary {
  id: string;
  slug: string;
  name: string;
  type: StudioType;
  memberCount: number;
}

/**
 * Studio detail — one studio's public-facing shell, returned by
 * `GET /studio/:slug`. The shell is visible to any authenticated user (a
 * studio's `/studio/{slug}` page is its front door, like a profile page);
 * `myStudioRole` tells the viewer their relationship to it: `admin` /
 * `member`, or `null` when they are not a member (a guest). Private content
 * inside the studio's tabs is gated by this role (later slices).
 */
export interface StudioDetail extends StudioSummary {
  myStudioRole: StudioRole | null;
}
