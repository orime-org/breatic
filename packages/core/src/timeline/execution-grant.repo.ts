// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Data access for `timeline_execution_grants` (inner#1711 design §3.4): which Projects may resolve and preview what
 * an execution made. Acceptance grants the accepting Project, duplicating a Project copies its source's grants, the
 * web-source and preview routes answer through them, and a change to an execution reaches the Timelines of every
 * granted Project (#1490 design §4.7).
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type DbTx } from "@core/db/client.js";
import { timelineExecutionGrants as g } from "@core/db/schema.js";

/**
 * Grant an execution to a Project.
 * @param input - The grant.
 * @param input.executionId - The execution.
 * @param input.projectId - The Project.
 * @param tx - The transaction to write in.
 * @returns Nothing once the row is written.
 * @throws {Error} When the write fails, including a live grant for the pair already existing.
 */
export async function insertGrant(input: { executionId: string; projectId: string }, tx?: DbTx): Promise<void> {
  await (tx ?? db).insert(g).values(input);
}

/**
 * Give a copy every live grant its source Project holds.
 * @param sourceProjectId - The Project copied from.
 * @param copyProjectId - The new copy.
 * @param tx - The copy's own transaction: a grant that fails leaves no copy behind.
 * @returns Nothing once the rows are written.
 * @throws {Error} When the write fails.
 */
export async function copyGrants(sourceProjectId: string, copyProjectId: string, tx: DbTx): Promise<void> {
  await tx.execute(sql`
    INSERT INTO ${g} (${sql.identifier(g.executionId.name)}, ${sql.identifier(g.projectId.name)})
    SELECT ${g.executionId}, ${copyProjectId}::uuid FROM ${g}
    WHERE ${g.projectId} = ${sourceProjectId} AND ${g.deletedAt} IS NULL
    ON CONFLICT DO NOTHING
  `);
}

/**
 * Every Project holding a live grant to an execution: its own and any copy made while the grant was live.
 * @param executionId - The execution.
 * @returns Their ids, in order.
 * @throws {Error} When the read fails.
 */
export async function grantedProjectIds(executionId: string): Promise<string[]> {
  const rows = await db
    .select({ projectId: g.projectId })
    .from(g)
    .where(and(eq(g.executionId, executionId), isNull(g.deletedAt)))
    .orderBy(g.projectId);
  return rows.map((row) => row.projectId);
}

/**
 * Which of these executions a Project holds a live grant for.
 * @param projectId - The Project.
 * @param executionIds - The executions asked about.
 * @returns The granted ones.
 * @throws {Error} When the read fails.
 */
export async function grantedExecutionIds(projectId: string, executionIds: readonly string[]): Promise<Set<string>> {
  if (executionIds.length === 0) return new Set();
  const rows = await db
    .select({ executionId: g.executionId })
    .from(g)
    .where(and(eq(g.projectId, projectId), inArray(g.executionId, [...executionIds]), isNull(g.deletedAt)));
  return new Set(rows.map((row) => row.executionId));
}
