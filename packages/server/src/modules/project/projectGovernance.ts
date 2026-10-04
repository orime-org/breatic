// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Who may manage a project as an object — rename it, change its cover,
 * duplicate it, archive and restore it.
 *
 * The studio admin and the project's owner may rename, change the cover and
 * duplicate; only the studio admin may archive and restore. Nobody else may
 * do any of it, editors included.
 *
 * One rule, read in two places: the studio's project lists send it as flags
 * so a card's menu offers exactly what the server will accept, and the write
 * paths check it before they write. Managing the object is not entering the
 * project: the studio admin may rename a project they are not on, and still
 * has to ask to join before they can open it.
 */

import type { ProjectRole, StudioRole } from "@breatic/shared";

/** What a caller may do to one project from its card. */
export interface ProjectPermissions {
  /** Rename and change the cover. */
  canManageMeta: boolean;
  canDuplicate: boolean;
  canArchive: boolean;
  canRestore: boolean;
}

/** The caller's two roles, which is all the rule asks of the caller. */
export interface ProjectRoles {
  /** The caller's role in the project's studio, or null outside it. */
  studioRole: StudioRole | null;
  /** The caller's stored role on the project, or null when not on it. */
  projectRole: ProjectRole | null;
}

/** The facts the rule reads. */
export interface ProjectPermissionFacts extends ProjectRoles {
  archived: boolean;
}

/**
 * Whether the caller may rename, change the cover of and duplicate the
 * project, setting aside whether it is archived.
 * @param roles - The caller's studio and project roles
 * @returns True for the studio's admin and the project's owner
 */
export function mayManage(roles: ProjectRoles): boolean {
  return roles.studioRole === "admin" || roles.projectRole === "owner";
}

/**
 * Whether the caller may archive and restore the project.
 * @param roles - The caller's studio and project roles
 * @returns True for the studio's admin
 */
export function mayArchive(roles: ProjectRoles): boolean {
  return roles.studioRole === "admin";
}

/**
 * Decide what a caller may do to a project.
 * @param facts - The caller's studio role, stored project role, and the archive state
 * @returns The four permissions
 */
export function projectPermissions(facts: ProjectPermissionFacts): ProjectPermissions {
  const manages = !facts.archived && mayManage(facts);
  return {
    canManageMeta: manages,
    canDuplicate: manages,
    canArchive: !facts.archived && mayArchive(facts),
    canRestore: facts.archived && mayArchive(facts),
  };
}
