// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Who may manage a project as an object — rename it, change its cover,
 * duplicate it, archive and restore it — and who may leave it.
 *
 * The studio admin and the project's owner may rename, change the cover and
 * duplicate; only the studio admin may archive and restore. Nobody else may
 * do any of it, editors included. Any member but the owner may leave a live
 * project; the owner hands it over first.
 *
 * One rule, read by the studio's project lists and the project page, which
 * send it as flags so a card's menu and the title offer exactly what the
 * server will accept, and by the manage / archive write paths before they
 * write; leaving re-checks the same two facts (archived, owner) in
 * `projectMembersService.leave` so each refusal names its own reason.
 * Managing the object is not entering the project: the studio admin may rename a project they are not on, and still
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
  /** Leave the project: a live project's editors and viewers. */
  canLeave: boolean;
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
 * @returns The five permissions
 */
export function projectPermissions(facts: ProjectPermissionFacts): ProjectPermissions {
  const manages = !facts.archived && mayManage(facts);
  return {
    canManageMeta: manages,
    canDuplicate: manages,
    canArchive: !facts.archived && mayArchive(facts),
    canRestore: facts.archived && mayArchive(facts),
    canLeave: !facts.archived && (facts.projectRole === "editor" || facts.projectRole === "viewer"),
  };
}
