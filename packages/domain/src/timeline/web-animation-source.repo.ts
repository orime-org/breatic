// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Data access for `timeline_web_animation_sources` (inner#1711 design §3.4): the immutable source version a
 * web-animation execution produced. The worker writes it; the server reads it to resolve and preview clips.
 *
 * At most one row per execution: the worker may settle the same terminal report more than once, and every attempt
 * lands on the row the first wrote.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, timelineWebAnimationSources as s, type DbTx } from "@breatic/core";
import type { WebAnimationSourceVersion } from "@breatic/shared";

/** What a source version is recorded with: a validated Manifest and the ingest Worker's report on the stored bytes. */
export type NewWebAnimationSource = Omit<WebAnimationSourceVersion, "id" | "createdAt">;

const columns = {
  id: s.id,
  executionId: s.executionId,
  packageKey: s.packageKey,
  manifestKey: s.manifestKey,
  packageSha256: s.packageSha256,
  packageBytes: s.packageBytes,
  manifestSha256: s.manifestSha256,
  runtimeVersion: s.runtimeVersion,
  fontSetVersion: s.fontSetVersion,
  width: s.width,
  height: s.height,
  fpsNum: s.fpsNum,
  fpsDen: s.fpsDen,
  durationFrames: s.durationFrames,
  createdAt: sql<string>`to_char(${s.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
};

/**
 * Record an execution's source version, or answer the one already recorded for it.
 * @param input - The source version.
 * @param tx - The transaction to write in.
 * @returns The execution's source version: this one, or the one an earlier settlement wrote.
 * @throws {Error} When the write fails.
 */
export async function insert(input: NewWebAnimationSource, tx?: DbTx): Promise<WebAnimationSourceVersion> {
  const executor = tx ?? db;
  const [row] = await executor.insert(s).values(input).onConflictDoNothing({ target: s.executionId }).returning(columns);
  if (row !== undefined) return row;
  const [existing] = await executor.select(columns).from(s).where(eq(s.executionId, input.executionId)).limit(1);
  if (existing === undefined) throw new Error(`Web animation source of execution ${input.executionId} conflicted but cannot be read`);
  return existing;
}

/**
 * Read a live source version.
 * @param id - The source version.
 * @param tx - The transaction to read in.
 * @returns It, or undefined when there is none.
 * @throws {Error} When the read fails.
 */
export async function findById(id: string, tx?: DbTx): Promise<WebAnimationSourceVersion | undefined> {
  const [row] = await (tx ?? db).select(columns).from(s).where(and(eq(s.id, id), isNull(s.deletedAt))).limit(1);
  return row;
}

/**
 * Read live source versions.
 * @param ids - The source versions.
 * @param tx - The transaction to read in.
 * @returns The ones that exist, in no particular order.
 * @throws {Error} When the read fails.
 */
export async function findByIds(ids: readonly string[], tx?: DbTx): Promise<WebAnimationSourceVersion[]> {
  if (ids.length === 0) return [];
  return (tx ?? db).select(columns).from(s).where(and(inArray(s.id, [...ids]), isNull(s.deletedAt)));
}
