// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The reads that list web-animation executions through a Project's grants (#1490 design §4.4).
 *
 * A Motion Space's own list walks `timeline_executions_space_order_idx` and checks each row against the grant; the
 * Timeline-made group and the Project's results walk the grant table through its two ordered indexes, which carry each
 * execution's creation time and origin. Every list pages by creation time then id, with a cursor carrying the time at
 * full precision, so a late page reads as many rows as the first.
 */

import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db, timelineExecutionGrants as g, timelineExecutions as t, timelineExecutionRepo } from "@breatic/core";
import type { TimelineExecution, TimelineExecutionStatus } from "@breatic/shared";
import { WEB_ANIMATION_OPEN_STATUSES } from "@breatic/shared/space-content";

/** Which list: a Motion Space's own, the Timeline-made group, or the Project's results for the Timeline picker. */
export type ListScope = "space" | "timeline" | "results";

/** Rows still in progress, rows that succeeded, or rows that failed, were cancelled or expired. */
export type ListGroup = "running" | "succeeded" | "failed";

/** The statuses each group holds. */
const GROUP_STATUSES: Record<ListGroup, readonly TimelineExecutionStatus[]> = {
  running: WEB_ANIMATION_OPEN_STATUSES,
  succeeded: ["succeeded"],
  failed: ["failed", "cancelled", "expired"],
};

/** One page's request. */
export interface ListParams {
  projectId: string;
  /** The Motion Space asking; read by the `space` scope only. */
  spaceId: string | null;
  scope: ListScope;
  /** Read by the `space` and `timeline` scopes; the results list is its own fixed set. */
  group: ListGroup;
  cursor: string | null;
  limit: number;
}

/** How many rows each group of a list holds. */
export type GroupTotals = Record<ListGroup, number>;

/** One page. */
export interface ListPage {
  rows: TimelineExecution[];
  nextCursor: string | null;
}

/** What the Timeline picker offers: a create or a modification that succeeded. */
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
 * The live grant of an execution to a Project, as an `EXISTS` condition on the executions table.
 * @param projectId - The Project.
 * @returns The condition.
 * @throws {never} Never.
 */
function grantedTo(projectId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${g} WHERE ${g.executionId} = ${t.id} AND ${g.projectId} = ${projectId} AND ${g.deletedAt} IS NULL)`;
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
    eq(g.projectId, params.projectId), isNull(g.deletedAt), isNull(t.deletedAt),
    params.scope === "timeline" ? eq(g.executionOrigin, "timeline") : and(inArray(t.kind, RESULT_KINDS), eq(t.status, "succeeded")),
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
  // The results list is its own fixed set; the other two read one group.
  const group = params.scope === "results" ? undefined : inArray(t.status, GROUP_STATUSES[params.group]);
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
export async function countGroups(params: Pick<ListParams, "projectId" | "spaceId" | "scope">): Promise<GroupTotals> {
  /**
   * One group's count.
   * @param group - The group.
   * @returns The count expression.
   */
  const countOf = (group: ListGroup): SQL<number> => sql<number>`count(*) FILTER (WHERE ${inArray(t.status, GROUP_STATUSES[group])})::int`;
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
      sql`${t.status} NOT IN ('failed', 'cancelled', 'expired')`,
      isNull(t.deletedAt),
      inArray(sql`${t.input}->>'sourceVersionId'`, [...key.sourceVersionIds]),
      grantedTo(key.projectId),
    ))
    .orderBy(desc(t.createdAt), desc(t.id));
  return rows.map(timelineExecutionRepo.toEntity);
}
