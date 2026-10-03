// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Who may manage a project as an object — rename it, change its cover,
 * duplicate it, archive and restore it.
 *
 * One rule, read in two places: the studio's project lists send it as flags
 * so a card's menu offers exactly what the server will accept, and the write
 * paths check it before they write. Managing the object is not entering the
 * project: the studio admin may rename a project they are not on, and still
 * has to ask to join before they can open it.
 */

import type { ProjectRole, StudioRole } from "@breatic/shared";
import { ROLE_RANK } from "@breatic/shared";

/** What a caller may do to one project from its card. */
export interface ProjectPermissions {
  /** Rename and change the cover. */
  canManageMeta: boolean;
  canDuplicate: boolean;
  canArchive: boolean;
  canRestore: boolean;
}

/** The facts the rule reads. */
export interface ProjectPermissionFacts {
  /** The caller's role in the project's studio, or null outside it. */
  studioRole: StudioRole | null;
  /** The caller's stored role on the project, or null when not on it. */
  projectRole: ProjectRole | null;
  archived: boolean;
}

/**
 * Decide what a caller may do to a project.
 * @param facts - The caller's studio role, stored project role, and the archive state
 * @returns The four permissions
 */
export function projectPermissions(facts: ProjectPermissionFacts): ProjectPermissions {
  const isAdmin = facts.studioRole === "admin";
  const editsContent =
    facts.projectRole !== null && ROLE_RANK[facts.projectRole] >= ROLE_RANK.editor;
  return {
    canManageMeta: !facts.archived && (isAdmin || editsContent),
    canDuplicate: !facts.archived && editsContent,
    canArchive: !facts.archived && isAdmin,
    canRestore: facts.archived && isAdmin,
  };
}
