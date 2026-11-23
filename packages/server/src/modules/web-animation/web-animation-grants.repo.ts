// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Data access for `timeline_execution_grants` (inner#1711 design §3.4, #1490 design §4.4): which Projects may see,
 * resolve, preview, modify and export what an execution made. Only the server reads and writes it: acceptance grants
 * the accepting Project, duplicating a Project copies its source's grants, and every read answers through
 * {@link liveGrantOf}, so the lists and the single-row, web-source and preview reads agree on what is granted.
 *
 * A Motion Space's own list walks `timeline_executions_space_order_idx` and checks each row against the grant; the
 * Timeline-made group and the Project's results walk the grant table through its two ordered indexes, which carry each
 * execution's creation time and origin. Every list pages by creation time then id, with a cursor carrying the time at
 * full precision, so a late page reads as many rows as the first.
 */

import { and, desc, eq, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import { db, timelineExecutionGrants as g, timelineExecutions as t, type DbTx } from "@breatic/core";
import { timelineExecutionRepo } from "@breatic/domain";
import type { TimelineExecution, TimelineExecutionStatus } from "@breatic/shared";
import {
  WEB_ANIMATION_FAILED_STATUSES, WEB_ANIMATION_OPEN_STATUSES, type WebAnimationListGroup, type WebAnimationListScope,
} from "@breatic/shared/space-content";

/** Which list: a Motion list, or the Project's results for the Timeline picker. */
export type ListScope = WebAnimationListScope | "results";

/** The statuses each group holds. */
const GROUP_STATUSES: Record<WebAnimationListGroup, readonly TimelineExecutionStatus[]> = {
  running: WEB_ANIMATION_OPEN_STATUSES,
  succeeded: ["succeeded"],
  failed: WEB_ANIMATION_FAILED_STATUSES,
};

/** One page's request. */
export interface ListParams {
  projectId: string;
  /** The Motion Space asking; read by the `space` scope only. */
  spaceId: string | null;
  scope: ListScope;
  /** Which group of statuses the page reads. */
  group: WebAnimationListGroup;
  cursor: string | null;
  limit: number;
}

/** One page. */
export interface ListPage {
  rows: TimelineExecution[];
  nextCursor: string | null;
}

/** The kinds the Timeline picker offers: a create or a modification; it reads them in the succeeded group. */
const RESULT_KINDS: readonly TimelineExecution["kind"][] = ["web_animation_create", "web_animation_modify"];

/** The cursor could not be read. */
export class BadCursorError extends Error {
  /** The marker. */
  constructor() {
    super("web animation list cursor unreadable");
    this.name = "BadCursorError";
  }
}

/**
 * Where the next page starts: the last row's creation time at full precision and its id.
 * @param row - The last row of a page.
 * @returns The opaque cursor.
 * @throws {never} Never.
 */
function cursorAfter(row: TimelineExecution): string {
  return Buffer.from(JSON.stringify([row.createdAt, row.id]), "utf8").toString("base64url");
}

/** An execution id as Postgres writes a uuid. */
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A creation time as the repository writes it: UTC, to the microsecond. */
const CURSOR_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

/**
 * Whether a text is a creation time the repository wrote: its form, and a real instant, which a day the month does
 * not have fails because the parsed date prints back differently.
 * @param text - The text.
 * @returns Whether it is.
 * @throws {never} Never.
 */
function isCursorTime(text: string): boolean {
  if (!CURSOR_TIME.test(text)) return false;
  const parsed = new Date(text);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 23) === text.slice(0, 23);
}

/**
 * Read a cursor back; only what the cursor carries in exactly the form this repository writes reaches the query.
 * @param cursor - The opaque cursor.
 * @returns The time text and id it carries.
 * @throws {BadCursorError} When it is not one this repository wrote.
 */
function readCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string"
      && CURSOR_ID.test(parsed[1]) && isCursorTime(parsed[0])) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // Not base64url JSON: not a cursor of ours.
  }
  throw new BadCursorError();
}

/**
 * A grant row that is a Project's live grant: the one condition every read of the table uses.
 * @param projectId - The Project.
 * @returns The condition on the grant table.
 * @throws {never} Never.
 */
function liveGrantOf(projectId: string): SQL {
  return sql`(${g.projectId} = ${projectId} AND ${g.deletedAt} IS NULL)`;
}

/**
 * The live grant of an execution to a Project, as an `EXISTS` condition on the executions table.
 * @param projectId - The Project.
 * @returns The condition.
 * @throws {never} Never.
 */
function grantedTo(projectId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${g} WHERE ${g.executionId} = ${t.id} AND ${liveGrantOf(projectId)})`;
}

/**
 * Grant an execution to a Project, with the execution's creation time and origin the lists order and group by.
 * @param input - The grant.
 * @param input.executionId - The execution.
 * @param input.projectId - The Project.
 * @param input.executionCreatedAt - The execution's `createdAt` as the repository reads it, to the microsecond.
 * @param input.executionOrigin - The execution's origin.
 * @param tx - The transaction to write in.
 * @returns Nothing once the row is written.
 * @throws {Error} When the write fails, including a live grant for the pair already existing.
 */
export async function insertGrant(
  input: { executionId: string; projectId: string; executionCreatedAt: string; executionOrigin: TimelineExecution["origin"] },
  tx?: DbTx,
): Promise<void> {
  await (tx ?? db).insert(g).values({
    executionId: input.executionId,
    projectId: input.projectId,
    // The text keeps the microseconds a Date would drop, so the grant orders exactly as its execution does.
    executionCreatedAt: sql`${input.executionCreatedAt}::timestamptz`,
    executionOrigin: input.executionOrigin,
  });
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
    INSERT INTO ${g} (
      ${sql.identifier(g.executionId.name)}, ${sql.identifier(g.projectId.name)},
      ${sql.identifier(g.executionCreatedAt.name)}, ${sql.identifier(g.executionOrigin.name)}
    )
    SELECT ${g.executionId}, ${copyProjectId}::uuid, ${g.executionCreatedAt}, ${g.executionOrigin} FROM ${g}
    WHERE ${liveGrantOf(sourceProjectId)}
    ON CONFLICT DO NOTHING
  `);
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
    .where(and(liveGrantOf(projectId), inArray(g.executionId, [...executionIds])));
  return new Set(rows.map((row) => row.executionId));
}

/**
 * Which rows a list holds in every group, shared by its pages and its totals so the two always agree. The `space`
 * scope reads the executions table; the other two read the grant table joined to it. The Timeline-made group is read
 * by origin alone: the old Timeline only ever made creates.
 * @param params - The list.
 * @param params.projectId - The Project.
 * @param params.spaceId - The Motion Space, for the `space` scope.
 * @param params.scope - Which list.
 * @returns The condition.
 * @throws {never} Never.
 */
function scopeWhere(params: Pick<ListParams, "projectId" | "spaceId" | "scope">): SQL | undefined {
  if (params.scope === "space") return and(eq(t.spaceId, params.spaceId ?? ""), isNull(t.deletedAt), grantedTo(params.projectId));
  return and(
    liveGrantOf(params.projectId), isNull(t.deletedAt),
    params.scope === "timeline" ? eq(g.executionOrigin, "timeline") : inArray(t.kind, RESULT_KINDS),
  );
}

/**
 * Build one page's query: the newest `limit + 1` rows after the cursor, so a page knows whether another follows.
 * @param params - The page.
 * @returns The query, not yet run.
 * @throws {BadCursorError} When the cursor is not one this repository wrote.
 */
function pageQuery(params: ListParams): PromiseLike<timelineExecutionRepo.Row[]> & { getSQL(): SQL } {
  const after = params.cursor === null ? null : readCursor(params.cursor);
  const take = params.limit + 1;
  const group = inArray(t.status, GROUP_STATUSES[params.group]);
  if (params.scope === "space") {
    // A row comparison, so the index range starts at the cursor instead of filtering from the newest row.
    const cursorCondition = after === null ? undefined : sql`(${t.createdAt}, ${t.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`;
    return db.select(timelineExecutionRepo.columns).from(t)
      .where(and(scopeWhere(params), group, cursorCondition))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(take);
  }
  const cursorCondition = after === null ? undefined : sql`(${g.executionCreatedAt}, ${g.executionId}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`;
  return db.select(timelineExecutionRepo.columns).from(g)
    .innerJoin(t, eq(t.id, g.executionId))
    .where(and(scopeWhere(params), group, cursorCondition))
    .orderBy(desc(g.executionCreatedAt), desc(g.executionId))
    .limit(take);
}

/**
 * The query of one page as SQL, for reading its plan.
 * @param params - The page.
 * @returns The query.
 * @throws {BadCursorError} When the cursor is not one this repository wrote.
 */
export function listQuery(params: ListParams): SQL {
  return pageQuery(params).getSQL();
}

/**
 * Read one page.
 * @param params - The page.
 * @returns Its rows, newest first, and where the next starts.
 * @throws {BadCursorError} When the cursor is not one this repository wrote.
 * @throws {Error} When the read fails.
 */
export async function listPage(params: ListParams): Promise<ListPage> {
  const rows = (await pageQuery(params)).map(timelineExecutionRepo.toEntity);
  const more = rows.length > params.limit;
  const page = more ? rows.slice(0, params.limit) : rows;
  return { rows: page, nextCursor: more ? cursorAfter(page[page.length - 1]!) : null };
}

/**
 * How many rows each group of a list holds.
 * @param params - The list; its cursor and limit are not read.
 * @param params.projectId - The Project.
 * @param params.spaceId - The Motion Space, for the `space` scope.
 * @param params.scope - Which list.
 * @returns The count of each group.
 * @throws {Error} When the read fails.
 */
export async function countGroups(params: Pick<ListParams, "projectId" | "spaceId" | "scope">): Promise<Record<WebAnimationListGroup, number>> {
  /**
   * One group's count.
   * @param group - The group.
   * @returns The count expression.
   */
  const countOf = (group: WebAnimationListGroup): SQL<number> => sql<number>`count(*) FILTER (WHERE ${inArray(t.status, GROUP_STATUSES[group])})::int`;
  const counts = { running: countOf("running"), succeeded: countOf("succeeded"), failed: countOf("failed") };
  const [row] = params.scope === "space"
    ? await db.select(counts).from(t).where(scopeWhere(params))
    : await db.select(counts).from(g).innerJoin(t, eq(t.id, g.executionId)).where(scopeWhere(params));
  return { running: row?.running ?? 0, succeeded: row?.succeeded ?? 0, failed: row?.failed ?? 0 };
}

/**
 * The live exports of these source versions in a Motion Space that a Project holds a grant for: in the Space's own
 * Project, and, in a duplicated Project, the ones its source made in the same Space.
 * @param key - Where to look.
 * @param key.projectId - The Project asking.
 * @param key.spaceId - The Motion Space.
 * @param key.sourceVersionIds - The source versions.
 * @returns The exports, at most one per source version.
 * @throws {Error} When the read fails.
 */
export async function findLiveExports(key: { projectId: string; spaceId: string; sourceVersionIds: readonly string[] }): Promise<TimelineExecution[]> {
  if (key.sourceVersionIds.length === 0) return [];
  const rows = await db.select(timelineExecutionRepo.columns).from(t)
    .where(and(
      eq(t.spaceId, key.spaceId),
      eq(t.kind, "web_animation_export"),
      notInArray(t.status, [...WEB_ANIMATION_FAILED_STATUSES]),
      isNull(t.deletedAt),
      inArray(sql`${t.input}->>'sourceVersionId'`, [...key.sourceVersionIds]),
      grantedTo(key.projectId),
    ))
    .orderBy(desc(t.createdAt), desc(t.id));
  return rows.map(timelineExecutionRepo.toEntity);
}
