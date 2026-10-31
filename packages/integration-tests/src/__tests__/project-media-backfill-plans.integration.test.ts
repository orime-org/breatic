// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { assetRepo, createPgClient, getStorageAdapter, initCore, loadLocales, projectActivitiesRepo } from "@breatic/core";
import { nodeHistoryRepo } from "@breatic/domain";
import { scanMediaBackfillDocuments } from "@collab/services/yjs-documents.repo.js";

/** The isolated ownership scope used by one measured scanner. */
interface FixtureScope { ownerId: string; studioId: string; projectId: string }

/** A random UUID prefix with fixed-width ordinal scan positions. */
interface FixtureRange { prefix: string }

/** PostgreSQL observations used to count actual scan work. */
interface PlanNode {
  "Node Type": string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  "Relation Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
}

/** The complete JSON result returned by EXPLAIN ANALYZE. */
type ExplainRows = { "QUERY PLAN": { Plan: PlanNode }[] }[];

/** One scanner's measured first-page and late-page facts. */
interface PlanMeasurement {
  source: string;
  table: string;
  cursor: string;
  excludedBeforeScan: number;
  first: ExplainRows;
  late: ExplainRows;
}

const COUNT = 4000;
const BATCH = 17;
const LATE = 3000;
let sql: ReturnType<typeof createPgClient>;
let yjsSql: ReturnType<typeof createPgClient>;
const owned = { users: [] as string[], studios: [] as string[], projects: [] as string[], documents: [] as string[] };

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = createPgClient(inject("DATABASE_URL"), { name: "timeline-backfill-plan-business", max: 4, prepare: false });
  yjsSql = createPgClient(inject("YJS_DATABASE_URL"), { name: "timeline-backfill-plan-yjs", max: 4, prepare: false });
});

afterEach(async () => {
  try {
    if (owned.documents.length > 0) await yjsSql`UPDATE yjs_documents SET deleted_at = now() WHERE name = ANY(${owned.documents}::text[])`;
    if (owned.projects.length > 0) {
      await sql`UPDATE node_history SET deleted_at = now() WHERE project_id = ANY(${owned.projects}::uuid[])`;
      await sql`UPDATE project_activities SET deleted_at = now() WHERE project_id = ANY(${owned.projects}::uuid[])`;
      await sql`UPDATE tasks SET deleted_at = now() WHERE project_id = ANY(${owned.projects}::uuid[])`;
      await sql`UPDATE projects SET deleted_at = now() WHERE id = ANY(${owned.projects}::uuid[])`;
    }
    if (owned.studios.length > 0) {
      await sql`UPDATE studio_assets SET deleted_at = now() WHERE studio_id = ANY(${owned.studios}::uuid[])`;
      await sql`UPDATE studios SET deleted_at = now() WHERE id = ANY(${owned.studios}::uuid[])`;
    }
    if (owned.users.length > 0) await sql`UPDATE users SET deleted_at = now() WHERE id = ANY(${owned.users}::uuid[])`;
  } finally {
    for (const values of Object.values(owned)) values.length = 0;
  }
});

afterAll(async () => {
  await Promise.all([sql.end({ timeout: 1 }), yjsSql.end({ timeout: 1 })]);
});

/**
 * Reserve a random namespace with dense, lexically ordered UUID positions.
 * @returns The fixture's unique UUID prefix.
 * @throws {never} Never.
 */
function rangeFixture(): FixtureRange { return { prefix: randomUUID().slice(0, 24) }; }

/**
 * Name a fixed candidate position within this test's isolated range.
 * @param range - The fixture's random UUID namespace.
 * @param ordinal - The candidate's fixed integer position.
 * @returns Its canonical, lexically ordered UUID.
 * @throws {never} Never.
 */
function idAt(range: FixtureRange, ordinal: number): string {
  return `${range.prefix}${ordinal.toString(16).padStart(12, "0")}`;
}

/**
 * Create a live user, Studio and Project owned by this measurement only.
 * @returns The identities required by the source-table foreign keys.
 * @throws {Error} When fixture writes fail.
 */
async function scopeFixture(): Promise<FixtureScope> {
  const ownerId = randomUUID();
  await sql`INSERT INTO users (id, email, email_verified)
    VALUES (${ownerId}, ${`timeline-plans-${ownerId}@example.com`}, true)`;
  owned.users.push(ownerId);
  const studioId = randomUUID();
  await sql`INSERT INTO studios (id, created_by_user_id, slug, type, name)
    VALUES (${studioId}, ${ownerId}, ${studioId}, 'personal', 'Timeline plan fixture')`;
  owned.studios.push(studioId);
  const projectId = randomUUID();
  await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug)
    VALUES (${projectId}, ${studioId}, ${ownerId}, 'Timeline plan fixture', ${`plan-${projectId}`})`;
  owned.projects.push(projectId);
  return { ownerId, studioId, projectId };
}

/**
 * Traverse the complete observed plan, retaining its native node structure.
 * @param node - A PostgreSQL plan stage.
 * @returns Every measured stage including its nested scan stages.
 * @throws {never} Never.
 */
function flattenPlan(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

/**
 * Count tuples observed at the measured relation's actual scan stages.
 * @param nodes - The observed execution-plan stages.
 * @param table - The exact relation scanned by the production repository.
 * @returns Output, filtered and rechecked tuples multiplied by actual loops.
 * @throws {never} Never.
 */
function scannedRows(nodes: readonly PlanNode[], table: string): number {
  return nodes.filter((node) => node["Relation Name"] === table && node["Node Type"].includes("Scan"))
    .reduce((sum, node) => sum + (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)
      + (node["Rows Removed by Index Recheck"] ?? 0)) * node["Actual Loops"], 0);
}

/**
 * Record complete measured plans before checking bounded keyset work.
 * @param measurement - Actual first-page and late-page execution observations.
 * @throws {Error} When the plan does not seek from the cursor or reads unbounded rows.
 */
function assertPlans(measurement: PlanMeasurement): void {
  const { source, table, cursor, excludedBeforeScan, first, late } = measurement;
  const firstRoot = first[0]?.["QUERY PLAN"][0]?.Plan;
  const lateRoot = late[0]?.["QUERY PLAN"][0]?.Plan;
  if (firstRoot === undefined || lateRoot === undefined) throw new Error("EXPLAIN returned no execution plan");
  const firstNodes = flattenPlan(firstRoot);
  const lateNodes = flattenPlan(lateRoot);
  const firstScanned = scannedRows(firstNodes, table);
  const lateScanned = scannedRows(lateNodes, table);
  console.info("project_media_backfill_explain", JSON.stringify({ source, table, count: COUNT, batch: BATCH,
    lateOrdinal: LATE, cursor, excludedBeforeScan, firstScanned, lateScanned, first, late }));
  expect(firstRoot["Actual Rows"]).toBe(BATCH);
  expect(lateRoot["Actual Rows"]).toBe(BATCH);
  expect(firstScanned).toBeGreaterThanOrEqual(BATCH);
  expect(firstScanned).toBeLessThanOrEqual(BATCH + excludedBeforeScan);
  expect(lateScanned).toBeGreaterThanOrEqual(BATCH);
  expect(lateScanned).toBeLessThanOrEqual(BATCH * 2);
  expect(lateNodes.some((node) => {
    const condition = node["Index Cond"] ?? "";
    return condition.includes(cursor) && /\b(?:id|name)\b.*>/.test(condition);
  })).toBe(true);
}

/**
 * Validate the actual scanner's ordered first page without assuming an empty database.
 * @param ids - The immutable identities returned by the real owner method.
 * @throws {Error} When the scanner loses its page size or ordering contract.
 */
function assertFirstPage(ids: readonly string[]): void {
  expect(ids).toHaveLength(BATCH);
  expect(ids).toEqual([...ids].sort());
  expect(new Set(ids).size).toBe(BATCH);
}

describe("Project media backfill first and late query plans", () => {
  it("measures successful-history keyset work with the actual full-row projection", async () => {
    const scope = await scopeFixture();
    const range = rangeFixture();
    const nodeId = randomUUID();
    await sql`INSERT INTO node_history (id, project_id, node_id, user_id, entry_type, status, content)
      SELECT (${range.prefix} || lpad(to_hex(n), 12, '0'))::uuid, ${scope.projectId}::uuid,
        ${nodeId}::uuid, ${scope.ownerId}::uuid, 'upload', 'success', ${`https://assets.test.invalid/plan-history/${range.prefix}`} || n::text || '.mp4'
      FROM generate_series(1, ${COUNT}::int) AS n`;
    await sql`ANALYZE node_history`;
    const excluded = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM node_history
      WHERE status <> 'success' OR deleted_at IS NOT NULL`;
    const first = await nodeHistoryRepo.scanSuccessfulMediaHistory(null, BATCH);
    const cursor = idAt(range, LATE);
    const late = await nodeHistoryRepo.scanSuccessfulMediaHistory(cursor, BATCH);
    assertFirstPage(first.map((row) => row.id));
    expect(first.map((row) => row.status)).toEqual(Array.from({ length: BATCH }, () => "success"));
    expect(late.map((row) => row.id)).toEqual(Array.from({ length: BATCH }, (_, index) => idAt(range, LATE + 1 + index)));
    const firstPlan = await sql<ExplainRows>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM node_history WHERE status = 'success' AND deleted_at IS NULL ORDER BY id ASC LIMIT ${BATCH}`;
    const latePlan = await sql<ExplainRows>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM node_history WHERE status = 'success' AND deleted_at IS NULL
        AND id > ${cursor}::uuid ORDER BY id ASC LIMIT ${BATCH}`;
    assertPlans({ source: "node_history", table: "node_history", cursor, excludedBeforeScan: excluded[0]!.count, first: firstPlan, late: latePlan });
  });

  it("measures generation-linked assets with the actual full ledger-row projection", async () => {
    const scope = await scopeFixture();
    const range = rangeFixture();
    const taskId = randomUUID();
    await sql`INSERT INTO tasks (id, user_id, project_id, space_id, task_type, mode, status)
      VALUES (${taskId}, ${scope.ownerId}, ${scope.projectId}, ${randomUUID()}, 'video', 'append', 'completed')`;
    const adapter = await getStorageAdapter();
    const keyPrefix = `backfill-plan/${range.prefix}`;
    const urlPrefix = adapter.publicUrl(keyPrefix);
    await sql`INSERT INTO studio_assets
      (id, studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id, generation_task_id)
      SELECT (${range.prefix} || lpad(to_hex(n), 12, '0'))::uuid, ${scope.studioId}::uuid,
        md5(${range.prefix} || n::text) || md5(n::text || ${range.prefix}), ${keyPrefix} || n::text || '.mp4',
        ${urlPrefix} || n::text || '.mp4', 8192, 'video/mp4', 'video', 'ai', ${scope.ownerId}::uuid, ${taskId}::uuid
      FROM generate_series(1, ${COUNT}::int) AS n`;
    await sql`ANALYZE studio_assets`;
    const excluded = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM studio_assets
      WHERE generation_task_id IS NULL OR deleted_at IS NOT NULL`;
    const first = await assetRepo.scanGenerationMediaAssets(null, BATCH);
    const cursor = idAt(range, LATE);
    const late = await assetRepo.scanGenerationMediaAssets(cursor, BATCH);
    assertFirstPage(first.map((row) => row.id));
    expect(first.every((row) => row.generationTaskId !== null && row.deletedAt === null)).toBe(true);
    expect(late.map((row) => row.id)).toEqual(Array.from({ length: BATCH }, (_, index) => idAt(range, LATE + 1 + index)));
    expect(late.map((row) => row.generationTaskId)).toEqual(Array.from({ length: BATCH }, () => taskId));
    const firstPlan = await sql<ExplainRows>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM studio_assets WHERE generation_task_id IS NOT NULL AND deleted_at IS NULL ORDER BY id ASC LIMIT ${BATCH}`;
    const latePlan = await sql<ExplainRows>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM studio_assets WHERE generation_task_id IS NOT NULL AND deleted_at IS NULL
        AND id > ${cursor}::uuid ORDER BY id ASC LIMIT ${BATCH}`;
    assertPlans({ source: "generation_assets", table: "studio_assets", cursor, excludedBeforeScan: excluded[0]!.count, first: firstPlan, late: latePlan });
  });

  it("measures media activities with the actual event predicates and full-row projection", async () => {
    const scope = await scopeFixture();
    const range = rangeFixture();
    const payload = { kind: "video", fileUrl: "https://assets.test.invalid/plan-activity.mp4" };
    await sql`INSERT INTO project_activities (id, project_id, actor_user_id, type, payload)
      SELECT (${range.prefix} || lpad(to_hex(n), 12, '0'))::uuid, ${scope.projectId}::uuid,
        ${scope.ownerId}::uuid, CASE WHEN n % 2 = 0 THEN 'asset:uploaded' ELSE 'generation:succeeded' END, ${sql.json(payload)}
      FROM generate_series(1, ${COUNT}::int) AS n`;
    await sql`ANALYZE project_activities`;
    const excluded = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM project_activities
      WHERE type NOT IN ('asset:uploaded', 'generation:succeeded') OR deleted_at IS NOT NULL`;
    const first = await projectActivitiesRepo.scanMediaBackfill(null, BATCH);
    const cursor = idAt(range, LATE);
    const late = await projectActivitiesRepo.scanMediaBackfill(cursor, BATCH);
    assertFirstPage(first.map((row) => row.id));
    expect(first.every((row) => row.type === "asset:uploaded" || row.type === "generation:succeeded")).toBe(true);
    expect(late.map((row) => row.id)).toEqual(Array.from({ length: BATCH }, (_, index) => idAt(range, LATE + 1 + index)));
    expect(late.map((row) => row.payload)).toEqual(Array.from({ length: BATCH }, () => payload));
    const firstPlan = await sql<ExplainRows>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM project_activities WHERE type IN ('asset:uploaded', 'generation:succeeded')
        AND deleted_at IS NULL ORDER BY id ASC LIMIT ${BATCH}`;
    const latePlan = await sql<ExplainRows>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM project_activities WHERE type IN ('asset:uploaded', 'generation:succeeded')
        AND deleted_at IS NULL AND id > ${cursor}::uuid ORDER BY id ASC LIMIT ${BATCH}`;
    assertPlans({ source: "media_activities", table: "project_activities", cursor, excludedBeforeScan: excluded[0]!.count, first: firstPlan, late: latePlan });
  });

  it("measures live Space documents with the actual name and byte projection", async () => {
    const scope = await scopeFixture();
    const range = rangeFixture();
    const prefix = `project-${scope.projectId}/canvas-`;
    const names = Array.from({ length: COUNT }, (_, index) => `${prefix}${idAt(range, index + 1)}`);
    const data = Buffer.from([0, 0]);
    await yjsSql`INSERT INTO yjs_documents (name, data)
      SELECT ${prefix} || ${range.prefix} || lpad(to_hex(n), 12, '0'), ${data}
      FROM generate_series(1, ${COUNT}::int) AS n`;
    owned.documents.push(...names);
    await yjsSql`ANALYZE yjs_documents`;
    const excluded = await yjsSql<{ count: number }[]>`SELECT count(*)::int AS count FROM yjs_documents
      WHERE deleted_at IS NOT NULL OR name !~ '^project-[^/]+/(canvas|document|timeline)-[^/]+$'`;
    const first = await scanMediaBackfillDocuments(null, BATCH);
    const cursor = `${prefix}${idAt(range, LATE)}`;
    const late = await scanMediaBackfillDocuments(cursor, BATCH);
    assertFirstPage(first.map((row) => row.name));
    for (const row of first) expect(row.name).toMatch(/^project-[^/]+\/(?:canvas|document|timeline)-[^/]+$/);
    expect(late.map((row) => row.name)).toEqual(Array.from({ length: BATCH }, (_, index) => `${prefix}${idAt(range, LATE + 1 + index)}`));
    expect(late.map((row) => Buffer.from(row.data))).toEqual(Array.from({ length: BATCH }, () => data));
    const firstPlan = await yjsSql<ExplainRows>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT name, data FROM yjs_documents WHERE deleted_at IS NULL
        AND name ~ '^project-[^/]+/(canvas|document|timeline)-[^/]+$' ORDER BY name ASC LIMIT ${BATCH}`;
    const latePlan = await yjsSql<ExplainRows>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT name, data FROM yjs_documents WHERE deleted_at IS NULL
        AND name ~ '^project-[^/]+/(canvas|document|timeline)-[^/]+$' AND name > ${cursor} ORDER BY name ASC LIMIT ${BATCH}`;
    assertPlans({ source: "space_documents", table: "yjs_documents", cursor, excludedBeforeScan: excluded[0]!.count, first: firstPlan, late: latePlan });
  });
});
