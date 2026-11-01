// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createHash, randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { assetRepo, createPgClient, getStorageAdapter, initCore, loadLocales, projectActivitiesRepo } from "@breatic/core";
import { nodeHistoryRepo, taskRepo, uploadGrantRepo } from "@breatic/domain";
import { scanMediaBackfillDocuments } from "@collab/services/yjs-documents.repo.js";

interface Scope { ownerId: string; studioId: string; projectId: string }
interface IdRange { prefix: string; before: string; last: string }
interface PlanNode {
  "Node Type": string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  "Relation Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
}
interface GrantOptions {
  state?: "consumed" | "pending" | "void";
  projectId?: string | null;
  assetId?: string | null;
  expired?: boolean;
}
type SnapshotTable = "upload_grants" | "node_history" | "studio_assets" | "tasks" | "project_activities";

let sql: ReturnType<typeof createPgClient>;
let yjsSql: ReturnType<typeof createPgClient>;
const owned = {
  users: [] as string[], studios: [] as string[], projects: [] as string[],
  grants: [] as string[], history: [] as string[], assets: [] as string[],
  tasks: [] as string[], activities: [] as string[], documents: [] as string[],
};

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = createPgClient(inject("DATABASE_URL"), { name: "timeline-media-scan-business-test", max: 4, prepare: false });
  yjsSql = createPgClient(inject("YJS_DATABASE_URL"), { name: "timeline-media-scan-yjs-test", max: 4, prepare: false });
});

afterEach(async () => {
  try {
    if (owned.documents.length > 0) await yjsSql`UPDATE yjs_documents SET deleted_at = now() WHERE name = ANY(${owned.documents}::text[])`;
    // Upload grants are short-lived credentials with no soft-delete column.
    if (owned.grants.length > 0) await sql`DELETE FROM upload_grants WHERE id = ANY(${owned.grants}::uuid[])`;
    if (owned.history.length > 0) await sql`UPDATE node_history SET deleted_at = now() WHERE id = ANY(${owned.history}::uuid[])`;
    if (owned.activities.length > 0) await sql`UPDATE project_activities SET deleted_at = now() WHERE id = ANY(${owned.activities}::uuid[])`;
    if (owned.assets.length > 0) await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ANY(${owned.assets}::uuid[])`;
    if (owned.tasks.length > 0) await sql`UPDATE tasks SET deleted_at = now() WHERE id = ANY(${owned.tasks}::uuid[])`;
    if (owned.projects.length > 0) await sql`UPDATE projects SET deleted_at = now() WHERE id = ANY(${owned.projects}::uuid[])`;
    if (owned.studios.length > 0) await sql`UPDATE studios SET deleted_at = now() WHERE id = ANY(${owned.studios}::uuid[])`;
    if (owned.users.length > 0) await sql`UPDATE users SET deleted_at = now() WHERE id = ANY(${owned.users}::uuid[])`;
  } finally {
    for (const values of Object.values(owned)) values.length = 0;
  }
});

afterAll(async () => {
  await Promise.all([sql.end({ timeout: 1 }), yjsSql.end({ timeout: 1 })]);
});

/**
 * Reserve a random UUID prefix with small deterministic ordinal boundaries.
 * @param count - The final fixture ordinal.
 * @returns The cursor immediately before the owned range and its final id.
 * @throws {never} Never.
 */
function idRange(count: number): IdRange {
  const prefix = randomUUID().slice(0, 24);
  return { prefix, before: `${prefix}000000000000`, last: `${prefix}${count.toString(16).padStart(12, "0")}` };
}

/**
 * Produce a stable id within one fixture's isolated lexical range.
 * @param range - The random namespace.
 * @param ordinal - The fixed row position.
 * @returns Its canonical UUID.
 * @throws {never} Never.
 */
function idAt(range: IdRange, ordinal: number): string {
  return `${range.prefix}${ordinal.toString(16).padStart(12, "0")}`;
}

/**
 * Seed a live owning scope independently of existing integration data.
 * @returns The fixture identities.
 * @throws {Error} When a database write fails.
 */
async function scopeFixture(): Promise<Scope> {
  const ownerId = randomUUID();
  await sql`INSERT INTO users (id, email, email_verified)
    VALUES (${ownerId}, ${`timeline-scan-${ownerId}@example.com`}, true)`;
  owned.users.push(ownerId);
  const studioId = randomUUID();
  await sql`INSERT INTO studios (id, created_by_user_id, slug, type, name)
    VALUES (${studioId}, ${ownerId}, ${studioId}, 'personal', 'Timeline scan fixture')`;
  owned.studios.push(studioId);
  const projectId = randomUUID();
  await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug)
    VALUES (${projectId}, ${studioId}, ${ownerId}, 'Timeline scan fixture', ${`scan-${projectId}`})`;
  owned.projects.push(projectId);
  return { ownerId, studioId, projectId };
}

/**
 * Seed a task with its actual Project provenance.
 * @param scope - Its producing user and default Project.
 * @param id - The immutable task identity.
 * @param options - Current scope, status and retained deletion state.
 * @throws {Error} When the fixture write fails.
 */
async function seedTask(scope: Scope, id: string, options: { projectId?: string | null; status?: string; deleted?: boolean } = {}): Promise<void> {
  const projectId = options.projectId === undefined ? scope.projectId : options.projectId;
  await sql`INSERT INTO tasks (id, user_id, project_id, space_id, task_type, mode, status, deleted_at)
    VALUES (${id}, ${scope.ownerId}, ${projectId}, ${randomUUID()}, 'video', 'append', ${options.status ?? "completed"},
      ${options.deleted ? new Date("2026-01-02T00:00:00Z") : null})`;
  owned.tasks.push(id);
}

/**
 * Seed a canonical registered asset with the exact stored generation pointer.
 * @param scope - Its owning scope.
 * @param id - Its stable identity.
 * @param options - Provenance and deletion fields read by the scan.
 * @returns The stored address.
 * @throws {Error} When fixture creation fails.
 */
async function seedAsset(scope: Scope, id: string, options: { taskId?: string | null; source?: string; deleted?: boolean } = {}): Promise<string> {
  const key = `backfill-scans/${id}.mp4`;
  const adapter = await getStorageAdapter();
  const fileUrl = adapter.publicUrl(key);
  const hash = createHash("sha256").update(id).digest("hex");
  await sql`INSERT INTO studio_assets
    (id, studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id,
     generation_task_id, deleted_at)
    VALUES (${id}, ${scope.studioId}, ${hash}, ${key}, ${fileUrl}, 8192, 'video/mp4', 'video',
      ${options.source ?? "upload"}, ${scope.ownerId}, ${options.taskId ?? null},
      ${options.deleted ? new Date("2026-01-02T00:00:00Z") : null})`;
  owned.assets.push(id);
  return fileUrl;
}

/**
 * Seed one credential retaining null provenance for service-level reporting.
 * @param scope - The credential owner.
 * @param id - Its immutable scan identity.
 * @param options - The recorded terminal state and optional provenance.
 * @throws {Error} When the fixture write fails.
 */
async function seedGrant(scope: Scope, id: string, options: GrantOptions = {}): Promise<void> {
  const state = options.state ?? "consumed";
  const projectId = options.projectId === undefined ? scope.projectId : options.projectId;
  await sql`INSERT INTO upload_grants
    (id, user_id, studio_id, storage_key, declared_size, expires_at, consumed_at, voided_at,
     project_id, asset_id, filename, created_at)
    VALUES (${id}, ${scope.ownerId}, ${scope.studioId}, ${`scan-grant/${id}`}, 8192,
      ${options.expired ? new Date("2020-01-01T00:00:00Z") : new Date("2100-01-01T00:00:00Z")},
      ${state === "consumed" ? new Date("2026-01-01T00:00:00Z") : null},
      ${state === "void" ? new Date("2026-01-01T00:00:00Z") : null},
      ${projectId}, ${options.assetId ?? null}, ${`grant-${id}.mp4`}, '2025-01-01T00:00:00.123456Z')`;
  owned.grants.push(id);
}

/**
 * Capture complete rows before a candidate scan.
 * @param table - One of the existing provenance tables.
 * @param ids - The exact fixture rows.
 * @returns Stored values for byte-independent read-only assertions.
 * @throws {Error} When the database read fails.
 */
async function snapshotRows(table: SnapshotTable, ids: string[]): Promise<{ row: unknown }[]> {
  return sql<{ row: unknown }[]>`SELECT to_jsonb(t) AS row FROM ${sql(table)} AS t
    WHERE id = ANY(${ids}::uuid[]) ORDER BY id`;
}

/**
 * Traverse only the owned UUID interval while validating every emitted page.
 * @param scan - The actual owner repository method.
 * @param range - The isolated lower and upper boundaries.
 * @param expected - Identities owned by this case.
 * @param limit - The exact small page size requested.
 * @returns Owned rows from real global pages.
 * @throws {Error} When scanning or an invariant fails.
 */
async function collectOwned<T extends { id: string }>(
  scan: (cursor: string | null, limit: number) => Promise<T[]>,
  range: IdRange,
  expected: readonly string[],
  limit: number,
): Promise<T[]> {
  const found: T[] = [];
  let cursor = range.before;
  while (cursor < range.last) {
    const page = await scan(cursor, limit);
    expect(page.length).toBeLessThanOrEqual(limit);
    if (page.length === 0) break;
    let previous = cursor;
    for (const row of page) {
      expect(row.id > previous).toBe(true);
      previous = row.id;
      if (row.id.startsWith(range.prefix) && row.id <= range.last) found.push(row);
    }
    cursor = page[page.length - 1]!.id;
  }
  expect(found.map((row) => row.id)).toEqual([...expected].sort());
  return found;
}

/**
 * Check the global first page without assuming other suites left no rows.
 * @param scan - The actual owner repository method.
 * @throws {Error} When scanning or the page contract fails.
 */
async function firstPage<T extends { id: string }>(scan: (cursor: string | null, limit: number) => Promise<T[]>): Promise<void> {
  const page = await scan(null, 1);
  expect(page).toHaveLength(1);
  const next = await scan(page[0]!.id, 1);
  expect(next.length).toBeLessThanOrEqual(1);
  if (next[0] !== undefined) expect(next[0].id > page[0]!.id).toBe(true);
}

describe("Project media backfill candidate scans", () => {
  it("pages consumed grants by stable id and retains incomplete or expired provenance", async () => {
    const scope = await scopeFixture();
    const mediaId = randomUUID();
    await seedAsset(scope, mediaId);
    const range = idRange(6);
    await seedGrant(scope, idAt(range, 4), { expired: true, projectId: null });
    await seedGrant(scope, idAt(range, 2), { projectId: null, assetId: mediaId });
    await seedGrant(scope, idAt(range, 6), { state: "void" });
    await seedGrant(scope, idAt(range, 1), { assetId: mediaId });
    await seedGrant(scope, idAt(range, 5), { state: "pending" });
    await seedGrant(scope, idAt(range, 3), { assetId: null });
    await sql`UPDATE upload_grants SET created_at = '2030-01-01T00:00:00Z',
      consumed_at = '2030-01-01T00:00:00Z' WHERE id = ${idAt(range, 2)}`;
    const expected = [1, 2, 3, 4].map((ordinal) => idAt(range, ordinal));
    const before = await snapshotRows("upload_grants", owned.grants);
    const rows = await collectOwned(uploadGrantRepo.scanConsumedMediaGrants, range, expected, 2);
    expect(rows.map((row) => ({ id: row.id, projectId: row.projectId, assetId: row.assetId }))).toEqual([
      { id: expected[0], projectId: scope.projectId, assetId: mediaId },
      { id: expected[1], projectId: null, assetId: mediaId },
      { id: expected[2], projectId: scope.projectId, assetId: null },
      { id: expected[3], projectId: null, assetId: null },
    ]);
    for (const row of rows) {
      expect(row.consumedAt).toBeInstanceOf(Date);
      expect(row.storageKey).toBe(`scan-grant/${row.id}`);
      expect(row.filename).toBe(`grant-${row.id}.mp4`);
    }
    await firstPage(uploadGrantRepo.scanConsumedMediaGrants);
    const resumed = await uploadGrantRepo.scanConsumedMediaGrants(expected[1]!, 1);
    expect(resumed.map((row) => row.id)).toEqual([expected[2]]);
    expect(await snapshotRows("upload_grants", owned.grants)).toEqual(before);
  });

  it("includes a pending grant consumed behind the cursor on a fresh rescan", async () => {
    const scope = await scopeFixture();
    const range = idRange(2);
    await seedGrant(scope, idAt(range, 1), { state: "pending" });
    await seedGrant(scope, idAt(range, 2));
    const initial = await uploadGrantRepo.scanConsumedMediaGrants(range.before, 1);
    expect(initial.map((row) => row.id)).toEqual([idAt(range, 2)]);
    await sql`UPDATE upload_grants SET consumed_at = now() WHERE id = ${idAt(range, 1)}`;
    const rescanned = await uploadGrantRepo.scanConsumedMediaGrants(range.before, 1);
    expect(rescanned.map((row) => row.id)).toEqual([idAt(range, 1)]);
  });

  it("retains every owned candidate across generated small batch sizes", async () => {
    const scope = await scopeFixture();
    const range = idRange(9);
    for (const ordinal of [9, 2, 7, 4, 1, 8, 3, 6, 5]) {
      await seedGrant(scope, idAt(range, ordinal), { state: ordinal % 2 === 1 ? "consumed" : "pending" });
    }
    const expected = [1, 3, 5, 7, 9].map((ordinal) => idAt(range, ordinal));
    const before = await snapshotRows("upload_grants", owned.grants);
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (limit) => {
      await collectOwned(uploadGrantRepo.scanConsumedMediaGrants, range, expected, limit);
    }), { numRuns: 8 });
    expect(await snapshotRows("upload_grants", owned.grants)).toEqual(before);
  });

  it("pages successful history while retaining text, snapshots and null content", async () => {
    const scope = await scopeFixture();
    const range = idRange(6);
    const variants = [
      { ordinal: 4, kind: "generation", status: "success", content: "Historical plain text", deleted: false },
      { ordinal: 2, kind: "generation", status: "success", content: null, deleted: false },
      { ordinal: 6, kind: "upload", status: "success", content: "Deleted media", deleted: true },
      { ordinal: 1, kind: "upload", status: "success", content: "https://assets.test.invalid/history.mp4", deleted: false },
      { ordinal: 5, kind: "generation", status: "failed", content: null, deleted: false },
      { ordinal: 3, kind: "snapshot", status: "success", content: "Snapshot text", deleted: false },
    ];
    for (const row of variants) {
      const id = idAt(range, row.ordinal);
      await sql`INSERT INTO node_history
        (id, project_id, node_id, user_id, entry_type, status, content, deleted_at, created_at)
        VALUES (${id}, ${scope.projectId}, ${randomUUID()}, ${scope.ownerId}, ${row.kind}, ${row.status}, ${row.content},
          ${row.deleted ? new Date("2026-01-02T00:00:00Z") : null}, '2025-01-01T00:00:00.123456Z')`;
      owned.history.push(id);
    }
    await sql`UPDATE node_history SET created_at = '2030-01-01T00:00:00Z' WHERE id = ${idAt(range, 2)}`;
    const before = await snapshotRows("node_history", owned.history);
    const expected = [1, 2, 3, 4].map((ordinal) => idAt(range, ordinal));
    const rows = await collectOwned(nodeHistoryRepo.scanSuccessfulMediaHistory, range, expected, 2);
    expect(rows.map((row) => ({ id: row.id, type: row.entryType, content: row.content }))).toEqual([
      { id: expected[0], type: "upload", content: "https://assets.test.invalid/history.mp4" },
      { id: expected[1], type: "generation", content: null },
      { id: expected[2], type: "snapshot", content: "Snapshot text" },
      { id: expected[3], type: "generation", content: "Historical plain text" },
    ]);
    await firstPage(nodeHistoryRepo.scanSuccessfulMediaHistory);
    expect((await nodeHistoryRepo.scanSuccessfulMediaHistory(expected[1]!, 1)).map((row) => row.id)).toEqual([expected[2]]);
    expect(await snapshotRows("node_history", owned.history)).toEqual(before);
  });

  it("pages live generation-linked assets while preserving their original source values", async () => {
    const scope = await scopeFixture();
    const taskId = randomUUID();
    await seedTask(scope, taskId);
    const range = idRange(5);
    await seedAsset(scope, idAt(range, 3), { taskId, source: "cover" });
    await seedAsset(scope, idAt(range, 5), { taskId, deleted: true });
    await seedAsset(scope, idAt(range, 1), { taskId, source: "upload" });
    await seedAsset(scope, idAt(range, 4));
    await seedAsset(scope, idAt(range, 2), { taskId, source: "ai" });
    const before = await snapshotRows("studio_assets", owned.assets);
    const expected = [1, 2, 3].map((ordinal) => idAt(range, ordinal));
    const rows = await collectOwned(assetRepo.scanGenerationMediaAssets, range, expected, 1);
    expect(rows.map((row) => ({ source: row.source, generationTaskId: row.generationTaskId }))).toEqual([
      { source: "upload", generationTaskId: taskId },
      { source: "ai", generationTaskId: taskId },
      { source: "cover", generationTaskId: taskId },
    ]);
    await firstPage(assetRepo.scanGenerationMediaAssets);
    expect((await assetRepo.scanGenerationMediaAssets(expected[1]!, 1)).map((row) => row.id)).toEqual([expected[2]]);
    expect(await snapshotRows("studio_assets", owned.assets)).toEqual(before);
  });

  it("pages only live upload and successful-generation activity types with legacy payloads intact", async () => {
    const scope = await scopeFixture();
    const range = idRange(6);
    const variants = [
      { ordinal: 3, type: "generation:succeeded", payload: { source: "understand" }, deleted: false },
      { ordinal: 6, type: "asset:uploaded", payload: { fileUrl: "deleted.mp4", kind: "video" }, deleted: true },
      { ordinal: 2, type: "generation:succeeded", payload: {}, deleted: false },
      { ordinal: 5, type: "asset:deleted", payload: { fileUrl: "deleted-event.mp4", kind: "video" }, deleted: false },
      { ordinal: 1, type: "asset:uploaded", payload: { fileUrl: "https://assets.test.invalid/event.mp4", kind: "video" }, deleted: false },
      { ordinal: 4, type: "generation:failed", payload: { source: "task" }, deleted: false },
    ];
    for (const row of variants) {
      const id = idAt(range, row.ordinal);
      await sql`INSERT INTO project_activities (id, project_id, type, payload, deleted_at, created_at)
        VALUES (${id}, ${scope.projectId}, ${row.type}, ${sql.json(row.payload)},
          ${row.deleted ? new Date("2026-01-02T00:00:00Z") : null}, '2025-01-01T00:00:00.123456Z')`;
      owned.activities.push(id);
    }
    await sql`UPDATE project_activities SET created_at = '2030-01-01T00:00:00Z' WHERE id = ${idAt(range, 2)}`;
    const before = await snapshotRows("project_activities", owned.activities);
    const expected = [1, 2, 3].map((ordinal) => idAt(range, ordinal));
    const rows = await collectOwned(projectActivitiesRepo.scanMediaBackfill, range, expected, 2);
    expect(rows.map((row) => ({ type: row.type, payload: row.payload }))).toEqual([
      { type: "asset:uploaded", payload: { fileUrl: "https://assets.test.invalid/event.mp4", kind: "video" } },
      { type: "generation:succeeded", payload: {} },
      { type: "generation:succeeded", payload: { source: "understand" } },
    ]);
    await firstPage(projectActivitiesRepo.scanMediaBackfill);
    expect((await projectActivitiesRepo.scanMediaBackfill(expected[1]!, 1)).map((row) => row.id)).toEqual([expected[2]]);
    expect(await snapshotRows("project_activities", owned.activities)).toEqual(before);
  });

  it("resolves one unique requested task batch across Projects and preserves null Project provenance", async () => {
    const first = await scopeFixture();
    const second = await scopeFixture();
    const range = idRange(5);
    await seedTask(first, idAt(range, 3), { projectId: null, status: "failed" });
    await seedTask(second, idAt(range, 2), { status: "pending" });
    await seedTask(first, idAt(range, 5), { status: "running" });
    await seedTask(first, idAt(range, 1));
    await seedTask(first, idAt(range, 4), { deleted: true });
    const before = await snapshotRows("tasks", owned.tasks);
    const requested = Object.freeze([
      idAt(range, 3), idAt(range, 1), idAt(range, 4), idAt(range, 2), idAt(range, 1), randomUUID(),
    ]);
    const rows = await taskRepo.findLiveTasksByIds(requested);
    expect(rows.map((row) => ({ id: row.id, projectId: row.projectId, status: row.status }))).toEqual([
      { id: idAt(range, 1), projectId: first.projectId, status: "completed" },
      { id: idAt(range, 2), projectId: second.projectId, status: "pending" },
      { id: idAt(range, 3), projectId: null, status: "failed" },
    ]);
    expect(await taskRepo.findLiveTasksByIds([])).toEqual([]);
    expect((await taskRepo.findLiveTasksByIds([idAt(range, 2)])).map((row) => row.id)).toEqual([idAt(range, 2)]);
    expect(await snapshotRows("tasks", owned.tasks)).toEqual(before);
  });

  it("pages recognized live Space snapshots in name order without altering bytes or timestamps", async () => {
    const scope = await scopeFixture();
    const range = idRange(6);
    const prefix = `project-${scope.projectId}/`;
    const variants = [
      { name: `${prefix}timeline-${idAt(range, 3)}`, deleted: false },
      { name: `${prefix}canvas-${idAt(range, 1)}`, deleted: false },
      { name: `${prefix}document-${idAt(range, 2)}`, deleted: false },
      { name: `${prefix}canvas-${idAt(range, 4)}`, deleted: true },
      { name: `${prefix}meta`, deleted: false },
      { name: `${prefix}unknown-${idAt(range, 5)}`, deleted: false },
    ];
    for (const [index, row] of variants.entries()) {
      await yjsSql`INSERT INTO yjs_documents (name, data, created_at, updated_at, deleted_at)
        VALUES (${row.name}, ${Buffer.from([0, 255, index, 7, 13])}, '2025-01-01T00:00:00.123456Z',
          '2025-01-02T00:00:00.654321Z', ${row.deleted ? new Date("2026-01-02T00:00:00Z") : null})`;
      owned.documents.push(row.name);
    }
    await yjsSql`UPDATE yjs_documents SET created_at = '2030-01-01T00:00:00Z',
      updated_at = '2030-01-01T00:00:00Z' WHERE name = ${`${prefix}document-${idAt(range, 2)}`}`;
    const snapshot = async (): Promise<{ name: string; bytes: string; created: string; updated: string; deleted: string | null }[]> =>
      yjsSql`SELECT name, encode(data, 'hex') AS bytes, created_at::text AS created,
        updated_at::text AS updated, deleted_at::text AS deleted FROM yjs_documents
        WHERE name = ANY(${owned.documents}::text[]) ORDER BY name`;
    const before = await snapshot();
    const expected = variants.filter((row) => !row.deleted && !row.name.endsWith("/meta") && !row.name.includes("/unknown-")).map((row) => row.name).sort();
    const found: { name: string; data: Uint8Array }[] = [];
    let cursor = prefix;
    while (found.length < expected.length) {
      const page = await scanMediaBackfillDocuments(cursor, 1);
      expect(page).toHaveLength(1);
      expect(page[0]!.name > cursor).toBe(true);
      cursor = page[0]!.name;
      expect(cursor.startsWith(prefix)).toBe(true);
      found.push(page[0]!);
    }
    expect(found.map((row) => row.name)).toEqual(expected);
    for (const row of found) {
      const original = before.find((entry) => entry.name === row.name)!;
      expect(Buffer.from(row.data).toString("hex")).toBe(original.bytes);
    }
    const next = await scanMediaBackfillDocuments(expected[expected.length - 1]!, 1);
    expect(next.every((row) => !row.name.startsWith(prefix))).toBe(true);
    const global = await scanMediaBackfillDocuments(null, 1);
    expect(global).toHaveLength(1);
    expect(global[0]!.name).toMatch(/^project-.+\/(?:canvas|document|timeline)-.+$/);
    expect(await snapshot()).toEqual(before);
  });

  it("keeps first and late consumed-grant reads bounded in a measured large fixture", async () => {
    const scope = await scopeFixture();
    const count = 4000;
    const limit = 17;
    const range = idRange(count);
    await sql`INSERT INTO upload_grants
      (id, user_id, studio_id, storage_key, declared_size, expires_at, consumed_at, project_id)
      SELECT (${range.prefix} || lpad(to_hex(n), 12, '0'))::uuid, ${scope.ownerId}::uuid,
        ${scope.studioId}::uuid, ${`large-scan/${range.prefix}`} || n::text, 8192,
        '2100-01-01T00:00:00Z'::timestamptz, now(), ${scope.projectId}::uuid
      FROM generate_series(1, ${count}::int) AS n`;
    owned.grants.push(...Array.from({ length: count }, (_, index) => idAt(range, index + 1)));
    await sql`ANALYZE upload_grants`;
    const baselineExcluded = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM upload_grants WHERE consumed_at IS NULL`;
    const first = await uploadGrantRepo.scanConsumedMediaGrants(null, limit);
    const lateCursor = idAt(range, 3000);
    const late = await uploadGrantRepo.scanConsumedMediaGrants(lateCursor, limit);
    expect(first).toHaveLength(limit);
    expect(late.map((row) => row.id)).toEqual(Array.from({ length: limit }, (_, index) => idAt(range, 3001 + index)));
    const firstPlan = await sql<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM upload_grants WHERE consumed_at IS NOT NULL ORDER BY id ASC LIMIT ${limit}`;
    const latePlan = await sql<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM upload_grants WHERE consumed_at IS NOT NULL AND id > ${lateCursor}::uuid ORDER BY id ASC LIMIT ${limit}`;
    const firstNodes = flattenPlan(firstPlan[0]!["QUERY PLAN"][0]!.Plan);
    const lateNodes = flattenPlan(latePlan[0]!["QUERY PLAN"][0]!.Plan);
    const firstScanned = scannedRows(firstNodes);
    const lateScanned = scannedRows(lateNodes);
    console.info("project_media_backfill_explain", JSON.stringify({ count, limit, firstScanned, lateScanned, first: firstPlan, late: latePlan }));
    expect(firstScanned).toBeGreaterThanOrEqual(limit);
    expect(firstScanned).toBeLessThanOrEqual(limit + baselineExcluded[0]!.count);
    expect(lateScanned).toBeGreaterThanOrEqual(limit);
    expect(lateScanned).toBeLessThanOrEqual(limit * 2);
    expect(lateNodes.some((node) => /\bid\b.*>/.test(node["Index Cond"] ?? ""))).toBe(true);
  });
});

/**
 * Flatten PostgreSQL's observed plan without fixing its complete shape.
 * @param node - One actual plan node.
 * @returns Every measured plan stage.
 * @throws {never} Never.
 */
function flattenPlan(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

/**
 * Count tuples read and filtered at actual heap or index scan stages.
 * @param nodes - The measured plan stages.
 * @returns Physical row observations for the provenance relation.
 * @throws {never} Never.
 */
function scannedRows(nodes: readonly PlanNode[]): number {
  return nodes.filter((node) => node["Relation Name"] === "upload_grants" && node["Node Type"].includes("Scan"))
    .reduce((sum, node) => sum + (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) * node["Actual Loops"], 0);
}
