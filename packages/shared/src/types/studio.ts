// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio entity (v10 §6).
 *
 * V1 = personal Studio: every user has exactly one, auto-created at
 * registration. The `studios` table exists in V1 only as a foreign-key
 * target for `projects.studio_id`; the `studio_assets` and
 * `asset_models` tables that turn it into a real workspace are
 * deferred to the team-Studio phase (V2+).
 */

/** Studio entity (one per user in V1). */
export interface Studio {
  id: string;
  /**
   * Owner user — for V1 personal Studio this is the user who owns it.
   * Team Studio (V2+) may broaden ownership to a membership table.
   */
  ownerUserId: string;
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
