// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The three list reads keep the same cost on a late page as on the first (#1490 design §4.4): a Motion Space's own
 * executions through `timeline_executions_space_order_idx` and a grant check, the Timeline-made group and the Project's
 * results from the grant table through its two ordered indexes. Each read is run under `EXPLAIN (ANALYZE)` on page 1
 * and on page 10 of a Project with 400 rows, and the rows the scans read are compared. Another Project holds 20,000
 * rows, as every other Project's rows sit beside a Project's own in production; without them the planner reads the
 * two small tables whole, which says nothing about how the reads scale.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { db, initCore, loadLocales } from "@breatic/core";
import { sql as drizzleSql } from "drizzle-orm";
import * as webAnimationListRepo from "@server/modules/web-animation/web-animation-list.repo.js";
import type { ListScope } from "@server/modules/web-animation/web-animation-list.repo.js";

let pg: ReturnType<typeof postgres>;
const ROWS = 400;
const LIMIT = 20;
let projectId: string;
const motionSpace = randomUUID();

beforeAll(async () => {
  initCore(process.env);
  loadLocales();
  pg = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  const [user] = await pg<{ id: string }[]>`INSERT INTO users (email, email_verified) VALUES (${`wa-plan-${randomUUID()}@example.test`}, true) RETURNING id`;
  const [studio] = await pg<{ id: string }[]>`INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${user!.id}, ${randomUUID()}, 'personal', 'Plans') RETURNING id`;
  const [project] = await pg<{ id: string }[]>`INSERT INTO projects (studio_id, created_by_user_id, name, slug) VALUES (${studio!.id}, ${user!.id}, 'Plans', ${randomUUID()}) RETURNING id`;
  projectId = project!.id;
  // Half made in the Motion Space, half in the Timeline before; every fifth a failed one the results read skips.
  await pg`
    INSERT INTO timeline_executions (project_id, space_id, actor_user_id, kind, engine, action_id, input, input_hash, deadline_at, status, origin, created_at)
    SELECT ${projectId}, CASE WHEN n % 2 = 0 THEN ${motionSpace}::uuid ELSE gen_random_uuid() END, ${user!.id}, 'web_animation_create', 'deepseek',
           gen_random_uuid(), '{}'::jsonb, 'sha256:plan', now() + interval '2 hours',
           CASE WHEN n % 5 = 0 THEN 'failed' ELSE 'succeeded' END,
           CASE WHEN n % 2 = 0 THEN 'web_animation_space' ELSE 'timeline' END,
           now() - make_interval(secs => n)
    FROM generate_series(1, ${ROWS}) AS n`;
  await pg`INSERT INTO timeline_execution_grants (execution_id, project_id) SELECT id, project_id FROM timeline_executions WHERE project_id = ${projectId}`;
  const [other] = await pg<{ id: string }[]>`INSERT INTO projects (studio_id, created_by_user_id, name, slug) VALUES (${studio!.id}, ${user!.id}, 'Others', ${randomUUID()}) RETURNING id`;
  await pg`
    INSERT INTO timeline_executions (project_id, space_id, actor_user_id, kind, engine, action_id, input, input_hash, deadline_at, status, origin, created_at)
    SELECT ${other!.id}, gen_random_uuid(), ${user!.id}, 'web_animation_create', 'deepseek', gen_random_uuid(), '{}'::jsonb, 'sha256:other',
           now() + interval '2 hours', 'succeeded', CASE WHEN n % 2 = 0 THEN 'web_animation_space' ELSE 'timeline' END, now() - make_interval(secs => n)
    FROM generate_series(1, 20000) AS n`;
  await pg`INSERT INTO timeline_execution_grants (execution_id, project_id) SELECT id, project_id FROM timeline_executions WHERE project_id = ${other!.id}`;
  await pg`ANALYZE timeline_executions`;
  await pg`ANALYZE timeline_execution_grants`;
});

afterAll(async () => {
  await pg?.end({ timeout: 1 });
});

/** One node of an `EXPLAIN (FORMAT JSON)` plan. */
interface PlanNode { "Node Type": string; "Actual Rows"?: number; "Actual Loops"?: number; Plans?: PlanNode[] }

/**
 * The rows every scan in a plan read.
 * @param node - The plan's root.
 * @returns Their sum.
 */
function scanned(node: PlanNode): number {
  const own = node["Node Type"].includes("Scan") ? (node["Actual Rows"] ?? 0) * (node["Actual Loops"] ?? 1) : 0;
  return own + (node.Plans ?? []).reduce((sum, child) => sum + scanned(child), 0);
}

/**
 * The rows the scans read for one page of a read.
 * @param scope - Which read.
 * @param cursor - Where the page starts.
 * @returns The count.
 */
async function rowsRead(scope: ListScope, cursor: string | null): Promise<number> {
  const query = webAnimationListRepo.listQuery({ projectId, spaceId: motionSpace, scope, group: "done", cursor, limit: LIMIT });
  const result = await db.execute(drizzleSql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`);
  const plan = (result as unknown as Array<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>)[0]!["QUERY PLAN"][0]!.Plan;
  return scanned(plan);
}

/**
 * The cursor of the tenth page, read through the page function itself.
 * @param scope - Which read.
 * @returns It.
 */
async function tenthPageCursor(scope: ListScope): Promise<string> {
  let cursor: string | null = null;
  for (let page = 1; page < 10; page += 1) {
    const result: webAnimationListRepo.ListPage = await webAnimationListRepo.listPage({ projectId, spaceId: motionSpace, scope, group: "done", cursor, limit: LIMIT });
    expect(result.rows).toHaveLength(LIMIT);
    cursor = result.nextCursor;
    if (cursor === null) throw new Error(`${scope} ran out before page 10`);
  }
  return cursor!;
}

describe("list reads on a late page", () => {
  it.each(["space", "timeline", "results"] as const)("read about as many rows on page 10 as on page 1 (%s)", async (scope) => {
    const first = await rowsRead(scope, null);
    const late = await rowsRead(scope, await tenthPageCursor(scope));
    expect(late).toBeLessThanOrEqual(first * 1.5 + LIMIT);
  });
});
