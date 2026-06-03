// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project-level role types (v10 §7.2.1).
 *
 * Three roles, simple ladder. `owner` is the unique top role per
 * project (enforced by a partial unique index on `project_members`).
 * `edit` is the working collaborator. `view` can read but not write.
 *
 * `admin` is gone — v6 simplification. Don't reintroduce.
 */

/** Three project-level roles. */
export type ProjectRole = "owner" | "edit" | "view";

/**
 * Numeric rank for >= comparisons in `requireRole` middleware.
 *
 * Higher = more privileged. Used as `ROLE_RANK[memberRole] >= ROLE_RANK[required]`.
 */
export const ROLE_RANK: Record<ProjectRole, number> = {
  view: 1,
  edit: 2,
  owner: 3,
};

/**
 * One row of the `project_members` table — who has what role on a
 * given project.
 *
 * `addedBy` is `null` for the owner row written at project-creation
 * time (the creator has no inviter).
 */
export interface ProjectMember {
  projectId: string;
  userId: string;
  role: ProjectRole;
  addedBy: string | null;
  addedAt: Date;
  deletedAt: Date | null;
}
