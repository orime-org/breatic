// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Project instructions repository (#1400): the only module that reads or
 * writes `project_agent_instructions`. One row per Project; clearing sets
 * `deleted_at` and a later save brings the same row back.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, projectAgentInstructions } from "@breatic/core";
import type { ProjectAgentInstructionsEntity } from "@breatic/shared";

/**
 * Convert a Drizzle row to its entity.
 * @param row - A `project_agent_instructions` row.
 * @returns The entity.
 */
function toEntity(row: typeof projectAgentInstructions.$inferSelect): ProjectAgentInstructionsEntity {
  return {
    projectId: row.projectId,
    content: row.content,
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt,
  };
}

/**
 * The Project's instructions, unless there are none or they were cleared.
 * @param projectId - The Project.
 * @returns The live row, or undefined.
 */
export async function findActive(projectId: string): Promise<ProjectAgentInstructionsEntity | undefined> {
  const [row] = await db
    .select()
    .from(projectAgentInstructions)
    .where(and(eq(projectAgentInstructions.projectId, projectId), isNull(projectAgentInstructions.deletedAt)));
  return row === undefined ? undefined : toEntity(row);
}

/**
 * Save the Project's instructions, bringing a cleared row back.
 * @param projectId - The Project.
 * @param userId - Who saved them.
 * @param content - The text as typed.
 * @returns The saved row.
 */
export async function upsert(projectId: string, userId: string, content: string): Promise<ProjectAgentInstructionsEntity> {
  const [row] = await db
    .insert(projectAgentInstructions)
    .values({ projectId, content, updatedByUserId: userId })
    .onConflictDoUpdate({
      target: projectAgentInstructions.projectId,
      set: { content, updatedByUserId: userId, updatedAt: sql`now()`, deletedAt: null },
    })
    .returning();
  return toEntity(row!);
}

/**
 * Clear the Project's instructions; a Project with none is left as it is.
 * @param projectId - The Project.
 * @returns Nothing.
 */
export async function clear(projectId: string): Promise<void> {
  await db
    .update(projectAgentInstructions)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(projectAgentInstructions.projectId, projectId), isNull(projectAgentInstructions.deletedAt)));
}
