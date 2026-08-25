// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * Minimal personal-studio reference returned by EVERY auth endpoint
 * (`/auth/register`, `/auth/login`, `/auth/google`, `/auth/me`,
 * `/auth/setup-studio`) — no exceptions, so the client parses one shape
 * whichever door the user came through.
 * The frontend derives the user's display name from `name`, their avatar
 * from `avatarUrl`, and links to `/studio/{slug}`. A `null` ref is the
 * onboarding gate signal — the user has registered but not yet picked a
 * slug (email-registration rewrite, 2026-06-06).
 *
 * `avatarUrl` rides here rather than on the user because a person's
 * avatar IS their personal studio's avatar (the pointer model of #1808,
 * which moved it off `users`). INV-3 of that change — no `avatarUrl` on
 * the auth user object — still holds and is asserted in the auth route
 * tests; #1882 added the field inside this ref, not beside it.
 */
export interface PersonalStudioRef {
  name: string;
  slug: string;
  /** The user's avatar, or null when they have not uploaded one. */
  avatarUrl: string | null;
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
  /** Avatar URL, or `null` when none was uploaded. */
  avatarUrl: string | null;
  /** Self-description shown on the studio's front door; `null` when unset. */
  bio: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Studio-level roles (3-role model, 2026-06-07). Two role layers exist:
 * studio Admin/Maintainer/Guest (this type) and project Owner/Editor/Viewer
 * (`ProjectRole` in role.ts).
 *
 * - `admin`: the studio owner (transferable; one active admin per studio,
 *   enforced by a partial unique index on `studio_members`). Creates
 *   projects/collections + publishes works.
 * - `maintainer`: a member granted create rights — creates projects/collections,
 *   cannot publish works.
 * - `guest`: a plain member — neither creates nor publishes.
 *
 * `studio_members.role` is `varchar(16)` with no DB check, so the value set is
 * enforced here (no migration to add `maintainer`). Today only personal studios
 * exist (single admin); `maintainer`/`guest` become reachable when team studios
 * + their assignment flow land (a later slice).
 */
export type StudioRole = "admin" | "maintainer" | "guest";

/**
 * Numeric rank for `>=` comparisons, mirroring `ROLE_RANK` for project roles.
 *
 * Higher = more privileged. Used both by the studio-role gate and by the
 * decision layer, which has to ask whether an invitation would still raise the
 * person it was sent to.
 */
export const STUDIO_ROLE_RANK: Record<StudioRole, number> = {
  guest: 1,
  maintainer: 2,
  admin: 3,
};

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
  /**
   * The studio's avatar, or `null` when none was uploaded (callers render
   * initials). For a personal studio this is the user's own avatar — display
   * identity lives on the personal studio, not on `users` (#1808).
   */
  avatarUrl: string | null;
  /** Self-description shown on the studio's front door; `null` when unset. */
  bio: string | null;
  memberCount: number;
  /**
   * The viewing user's CURRENT role in this studio (`studio_members.role`),
   * or `null` when they are not a member (a non-member viewing the front door).
   * Transfer-safe — reflects the current admin, NOT the immutable
   * `createdByUserId`. Drives the rail's "My studios" (`admin`) vs "Joined
   * studios" (`maintainer`/`guest`) split, and the create gate
   * (`admin`/`maintainer`). For
   * `GET /studios` (the viewer's own memberships) it is always non-null.
   */
  myStudioRole: StudioRole | null;
}

/**
 * Studio detail — one studio's public-facing shell, returned by
 * `GET /studio/:slug`. Structurally identical to `StudioSummary`; the
 * difference is semantic — the front door is visible to any authenticated
 * user (a studio's `/studio/{slug}` page is its front door, like a profile
 * page), so `myStudioRole` is `null` for a non-member. Private
 * content inside the studio's tabs is gated by this role (later slices).
 */
export type StudioDetail = StudioSummary;

/**
 * Studio member summary — one member as returned by `GET /studio/:slug/members`
 * for the Members tab. Display fields (the member's display `name` from their
 * personal studio, email, avatar) + studio role + join date. A personal studio
 * returns exactly one of these (its admin — the creator); a team studio returns
 * all of them.
 */
export interface StudioMemberSummary {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: StudioRole;
  /** ISO-8601 join timestamp (`studio_members.addedAt`). */
  addedAt: string;
}

/** Studio invitation lifecycle status (invite-confirm handshake, 2026-06-14). */
export type StudioInvitationStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "expired"
  | "revoked";

/**
 * Pending studio-invitation summary — one in-flight invite as returned by
 * `GET /studio/:slug/members` (the `pendingInvitations` segment) for the
 * Members tab. Surfaced to admins so they can see who is "invited (pending)"
 * and revoke it. Display fields mirror {@link StudioMemberSummary};
 * `expiresAt` drives the countdown. Invite-confirm handshake, 2026-06-14.
 */
export interface PendingInvitationSummary {
  invitationId: string;
  invitedUserId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: StudioRole;
  /** The inviting admin's display name. */
  invitedByName: string;
  /** ISO-8601 expiry timestamp (`studio_invitations.expiresAt`). */
  expiresAt: string;
}

/**
 * `GET /studio/:slug/members` response — active members plus, for admins, the
 * in-flight pending invitations. The frontend renders pending rows in a
 * separate "invited (pending)" section, shown only to admins. Invite-confirm
 * handshake, 2026-06-14.
 */
export interface StudioMembersView {
  members: StudioMemberSummary[];
  pendingInvitations: PendingInvitationSummary[];
}

