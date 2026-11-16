// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Project instructions for the Agent (#1400): one text per Project that its
 * Owner and Editors read and save, and that every Agent request in the
 * Project carries at the end of its system prompt. The last save wins.
 */

import type { AgentInstructionsView, ProjectAgentInstructionsEntity } from "@breatic/shared";
import * as instructionsRepo from "@server/modules/conversation/agent-instructions.repo.js";
import * as projectService from "@server/modules/project/project.service.js";
import { profilesService } from "@breatic/domain";

const NONE: AgentInstructionsView = { text: "", updatedBy: null, updatedAt: null };

/**
 * The view of a saved row, naming its editor as the member list does: the
 * personal studio's name, or the part of the email before the @.
 * @param row - The saved row.
 * @returns The view.
 */
async function viewOf(row: ProjectAgentInstructionsEntity): Promise<AgentInstructionsView> {
  const profile = (await profilesService.profilesOf([row.updatedByUserId])).get(row.updatedByUserId);
  const name = profile === undefined
    ? null
    : profile.name !== null && !profile.deleted
      ? profile.name
      : (profile.email?.split("@")[0] ?? null);
  return { text: row.content, updatedBy: name, updatedAt: row.updatedAt.toISOString() };
}

/**
 * Read the Project's instructions for one of its editors.
 * @param projectId - The Project.
 * @param userId - Who is reading.
 * @returns The instructions, empty when there are none.
 * @throws {NotFoundError} When the user is not a member of the Project.
 * @throws {ForbiddenError} When the user may not edit it.
 */
export async function read(projectId: string, userId: string): Promise<AgentInstructionsView> {
  await projectService.assertAccess(projectId, userId, "editor");
  const row = await instructionsRepo.findActive(projectId);
  return row === undefined ? NONE : viewOf(row);
}

/**
 * Save the Project's instructions as typed; a text that is empty or only
 * whitespace clears them.
 * @param projectId - The Project.
 * @param userId - Who is saving.
 * @param text - The text as typed.
 * @returns The instructions now in place.
 * @throws {NotFoundError} When the user is not a member of the Project.
 * @throws {ForbiddenError} When the user may not edit it.
 */
export async function save(projectId: string, userId: string, text: string): Promise<AgentInstructionsView> {
  await projectService.assertAccess(projectId, userId, "editor");
  if (text.trim() === "") {
    await instructionsRepo.clear(projectId);
    return NONE;
  }
  return viewOf(await instructionsRepo.upsert(projectId, userId, text));
}

/**
 * The Project's instructions as the Agent turn sends them, for a turn whose
 * access was already checked.
 * @param projectId - The Project.
 * @returns The text, or undefined when there are none.
 */
export async function textFor(projectId: string): Promise<string | undefined> {
  return (await instructionsRepo.findActive(projectId))?.content;
}
