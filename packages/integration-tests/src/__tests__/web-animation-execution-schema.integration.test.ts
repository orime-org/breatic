// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the Motion Space migration adds to the execution and grant tables (#1490 design §4.6, §6.4, §13.1): the three
 * kinds and what each may store, the export result column, the one live export per source in a Space, and the two
 * grant columns a trigger fills, so the previous server's two-column grant writes keep working.
 */

import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, db, getStorageAdapter, initCore, loadLocales, timelineExecutionRepo } from "@breatic/core";
import type { TimelineExecution } from "@breatic/shared";
import * as grantRepo from "@server/modules/timeline/execution-grant.repo.js";

let sql: ReturnType<typeof createPgClient>;
const owned = { users: [] as string[], studios: [] as string[], projects: [] as string[], executions: [] as string[], grants: [] as string[], assets: [] as string[] };

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = createPgClient(inject("DATABASE_URL"), { name: "web-animation-schema-test-driver", max: 4, prepare: false });
});

afterEach(async () => {
  try {
    if (owned.grants.length > 0) await sql`UPDATE timeline_execution_grants SET deleted_at = now() WHERE id = ANY(${owned.grants}::uuid[])`;
    await sql`UPDATE timeline_execution_grants SET deleted_at = now() WHERE execution_id = ANY(${owned.executions}::uuid[]) AND deleted_at IS NULL`;
    if (owned.executions.length > 0) await sql`UPDATE timeline_executions SET deleted_at = now() WHERE id = ANY(${owned.executions}::uuid[])`;
    if (owned.assets.length > 0) await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ANY(${owned.assets}::uuid[])`;
    if (owned.projects.length > 0) await sql`UPDATE projects SET deleted_at = now() WHERE id = ANY(${owned.projects}::uuid[])`;
    if (owned.studios.length > 0) await sql`UPDATE studios SET deleted_at = now() WHERE id = ANY(${owned.studios}::uuid[])`;
    if (owned.users.length > 0) await sql`UPDATE users SET deleted_at = now() WHERE id = ANY(${owned.users}::uuid[])`;
  } finally {
    for (const list of Object.values(owned)) list.length = 0;
  }
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

interface Fixture { projectId: string; ownerId: string; studioId: string }

/**
 * Insert an owner, a Studio and a Project.
 * @returns Their ids.
 * @throws {Error} When a fixture write fails.
 */
async function seedProject(): Promise<Fixture> {
  const ownerId = randomUUID();
  await sql`INSERT INTO users (id, email, email_verified) VALUES (${ownerId}, ${`wa-schema-${ownerId}@example.com`}, true)`;
  owned.users.push(ownerId);
  const studioId = randomUUID();
  await sql`INSERT INTO studios (id, created_by_user_id, slug, type, name) VALUES (${studioId}, ${ownerId}, ${studioId}, 'personal', 'Motion schema studio')`;
  owned.studios.push(studioId);
  const projectId = randomUUID();
  await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug) VALUES (${projectId}, ${studioId}, ${ownerId}, 'Motion schema test', ${`wa-${projectId}`})`;
  owned.projects.push(projectId);
  return { projectId, ownerId, studioId };
}

/**
 * Insert a video asset an export can point at.
 * @param fixture - Its Studio and producer.
 * @returns The asset id.
 * @throws {Error} When the fixture write fails.
 */
async function seedAsset(fixture: Fixture): Promise<string> {
  const id = randomUUID();
  const key = `web-animation-schema/${id}.mp4`;
  const fileUrl = (await getStorageAdapter()).publicUrl(key);
  await sql`INSERT INTO studio_assets
    (id, studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id, width, height, duration_seconds)
    VALUES (${id}, ${fixture.studioId}, ${createHash("sha256").update(id).digest("hex")}, ${key}, ${fileUrl}, 8192, 'video/mp4',
      'video', 'ai', ${fixture.ownerId}, 1920, 1080, 4)`;
  owned.assets.push(id);
  return id;
}

const FPS = { num: 24, den: 1 };

/**
 * Insert one execution through the repository, as new code does.
 * @param fixture - Its Project and actor.
 * @param kind - Which kind.
 * @param options - The Space and, for an export, its source version.
 * @param options.spaceId - The Space; a new one when omitted.
 * @param options.sourceVersionId - The export's source version; a new one when omitted.
 * @returns The row, or null when a unique index refused it.
 * @throws {Error} When the write fails otherwise.
 */
async function insert(
  fixture: Fixture,
  kind: TimelineExecution["kind"],
  options: { spaceId?: string; sourceVersionId?: string } = {},
): Promise<TimelineExecution | null> {
  const base = { projectId: fixture.projectId, spaceId: options.spaceId ?? randomUUID(), actorUserId: fixture.ownerId, actionId: randomUUID(), inputHash: `sha256:${randomUUID()}`, deadlineAt: new Date(Date.now() + 7_200_000), status: "queued" as const, origin: "web_animation_space" as const };
  const row = kind === "web_animation_export"
    ? await timelineExecutionRepo.insert({ ...base, kind, engine: null, input: { sourceVersionId: options.sourceVersionId ?? randomUUID(), width: 1920, height: 1080, fps: FPS, durationFrames: 96, videoKey: `generated/${randomUUID()}.mp4` } })
    : kind === "web_animation_modify"
      ? await timelineExecutionRepo.insert({ ...base, kind, engine: "deepseek", input: { baseSourceVersionId: randomUUID(), instruction: "Slower", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: FPS } })
      : await timelineExecutionRepo.insert({ ...base, kind, engine: "deepseek", input: { prompt: "A", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: FPS } });
  if (row !== null) owned.executions.push(row.id);
  return row;
}

/**
 * Insert a row and fail when a unique index refused it.
 * @param fixture - Its Project and actor.
 * @param kind - Which kind.
 * @param options - As {@link insert}.
 * @param options.spaceId - The Space.
 * @param options.sourceVersionId - The export's source version.
 * @returns The row.
 * @throws {Error} When the insert was refused.
 */
async function inserted(fixture: Fixture, kind: TimelineExecution["kind"], options: { spaceId?: string; sourceVersionId?: string } = {}): Promise<TimelineExecution> {
  const row = await insert(fixture, kind, options);
  if (row === null) throw new Error("Fixture execution refused");
  return row;
}

describe("timeline_executions — the three kinds", () => {
  it("stores a create, a modify and an export", async () => {
    const fixture = await seedProject();
    const rows = [await inserted(fixture, "web_animation_create"), await inserted(fixture, "web_animation_modify"), await inserted(fixture, "web_animation_export")];
    expect(rows.map((row) => [row.kind, row.engine])).toEqual([
      ["web_animation_create", "deepseek"], ["web_animation_modify", "deepseek"], ["web_animation_export", null],
    ]);
  });

  it("refuses a kind outside the three", async () => {
    const row = await inserted(await seedProject(), "web_animation_create");
    await expect(sql`UPDATE timeline_executions SET kind = 'web_animation_delete' WHERE id = ${row.id}`).rejects.toThrow(/check/i);
  });

  it("accepts the rendering phase", async () => {
    const row = await inserted(await seedProject(), "web_animation_export");
    await sql`UPDATE timeline_executions SET phase = 'rendering' WHERE id = ${row.id}`;
    expect((await timelineExecutionRepo.findById(row.id))?.phase).toBe("rendering");
  });

  it("refuses an engine on an export and a missing engine on a create", async () => {
    const fixture = await seedProject();
    const exported = await inserted(fixture, "web_animation_export");
    const created = await inserted(fixture, "web_animation_create");
    await expect(sql`UPDATE timeline_executions SET engine = 'deepseek' WHERE id = ${exported.id}`).rejects.toThrow(/check/i);
    await expect(sql`UPDATE timeline_executions SET engine = NULL WHERE id = ${created.id}`).rejects.toThrow(/check/i);
  });

  it("refuses a source version result on an export and an asset result on a create", async () => {
    const fixture = await seedProject();
    const asset = await seedAsset(fixture);
    const exported = await inserted(fixture, "web_animation_export");
    const created = await inserted(fixture, "web_animation_create");
    await expect(sql`UPDATE timeline_executions SET result_source_version_id = ${randomUUID()} WHERE id = ${exported.id}`).rejects.toThrow(/check/i);
    await expect(sql`UPDATE timeline_executions SET result_asset_id = ${asset} WHERE id = ${created.id}`).rejects.toThrow(/check/i);
  });

  it("refuses an origin outside timeline and web_animation_space", async () => {
    const row = await inserted(await seedProject(), "web_animation_create");
    await expect(sql`UPDATE timeline_executions SET origin = 'agent' WHERE id = ${row.id}`).rejects.toThrow(/check/i);
  });
});

describe("timelineExecutionRepo.transition — an export's result", () => {
  it("stores the registered video asset on success and no source version", async () => {
    const fixture = await seedProject();
    const asset = await seedAsset(fixture);
    const row = await inserted(fixture, "web_animation_export");
    const claimed = await timelineExecutionRepo.transition({ id: row.id, event: { type: "claim" } });
    const done = await timelineExecutionRepo.transition({ id: row.id, event: { type: "success", fence: claimed.row.fence, resultAssetId: asset } });
    expect(done).toMatchObject({ applied: true, row: { status: "succeeded", resultAssetId: asset, resultSourceVersionId: null } });
  });
});

describe("timeline_executions_export_source_idx — one live export per source in a Space", () => {
  it("refuses a second live export of the same source in the same Space", async () => {
    const fixture = await seedProject();
    const spaceId = randomUUID();
    const sourceVersionId = randomUUID();
    await inserted(fixture, "web_animation_export", { spaceId, sourceVersionId });
    expect(await insert(fixture, "web_animation_export", { spaceId, sourceVersionId })).toBeNull();
  });

  it("lets the source be exported again once the earlier export failed", async () => {
    const fixture = await seedProject();
    const spaceId = randomUUID();
    const sourceVersionId = randomUUID();
    const first = await inserted(fixture, "web_animation_export", { spaceId, sourceVersionId });
    await timelineExecutionRepo.transition({ id: first.id, event: { type: "failure", fence: null, reason: "enqueue_failed" } });
    const again = await insert(fixture, "web_animation_export", { spaceId, sourceVersionId });
    expect(again?.id).toEqual(expect.any(String));
    expect(again?.id).not.toBe(first.id);
  });

  it("keeps exports of the same source in two Motion Spaces apart", async () => {
    const fixture = await seedProject();
    const sourceVersionId = randomUUID();
    const first = await inserted(fixture, "web_animation_export", { sourceVersionId });
    const second = await inserted(fixture, "web_animation_export", { sourceVersionId });
    expect(second.id).not.toBe(first.id);
  });
});

describe("timeline_execution_grants — fields the trigger fills", () => {
  it("fills the execution's creation time and origin on a grant written with two columns", async () => {
    const fixture = await seedProject();
    const row = await inserted(fixture, "web_animation_create");
    await grantRepo.insertGrant({ executionId: row.id, projectId: fixture.projectId });
    const [grant] = await sql<{ same_time: boolean; origin: string }[]>`SELECT g.execution_created_at = e.created_at AS same_time, g.execution_origin AS origin
      FROM timeline_execution_grants g JOIN timeline_executions e ON e.id = g.execution_id
      WHERE g.execution_id = ${row.id} AND g.project_id = ${fixture.projectId} AND g.deleted_at IS NULL`;
    expect(grant).toEqual({ same_time: true, origin: "web_animation_space" });
  });

  it("fills them on the grants a duplicated Project copies", async () => {
    const source = await seedProject();
    const copy = await seedProject();
    const row = await inserted(source, "web_animation_create");
    await grantRepo.insertGrant({ executionId: row.id, projectId: source.projectId });
    await db.transaction((tx) => grantRepo.copyGrants(source.projectId, copy.projectId, tx));
    const [grant] = await sql<{ same_time: boolean; origin: string }[]>`SELECT g.execution_created_at = e.created_at AS same_time, g.execution_origin AS origin
      FROM timeline_execution_grants g JOIN timeline_executions e ON e.id = g.execution_id
      WHERE g.execution_id = ${row.id} AND g.project_id = ${copy.projectId} AND g.deleted_at IS NULL`;
    expect(grant).toEqual({ same_time: true, origin: "web_animation_space" });
  });

  it("keeps the two columns equal to their execution on every grant, the backfilled ones included", async () => {
    const [mismatch] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM timeline_execution_grants g
      JOIN timeline_executions e ON e.id = g.execution_id
      WHERE g.execution_created_at IS DISTINCT FROM e.created_at OR g.execution_origin IS DISTINCT FROM e.origin`;
    expect(mismatch).toEqual({ count: 0 });
  });

  it("declares both columns NOT NULL", async () => {
    const rows = await sql<{ column_name: string; is_nullable: string }[]>`SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'timeline_execution_grants'
        AND column_name IN ('execution_created_at', 'execution_origin') ORDER BY column_name`;
    expect(rows).toEqual([
      { column_name: "execution_created_at", is_nullable: "NO" },
      { column_name: "execution_origin", is_nullable: "NO" },
    ]);
  });
});

describe("indexes for the three list reads", () => {
  it("orders a Space's executions, a Project's grants and a Project's grants by origin", async () => {
    const rows = await sql<{ indexname: string; indexdef: string }[]>`SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname IN (
        'timeline_executions_space_order_idx', 'timeline_execution_grants_order_idx', 'timeline_execution_grants_origin_order_idx',
        'timeline_executions_export_source_idx') ORDER BY indexname`;
    const byName = Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.timeline_executions_space_order_idx).toMatch(/\(space_id, created_at DESC, id DESC\)/);
    expect(byName.timeline_execution_grants_order_idx).toMatch(/\(project_id, execution_created_at DESC, execution_id DESC\)/);
    expect(byName.timeline_execution_grants_origin_order_idx).toMatch(/\(project_id, execution_origin, execution_created_at DESC, execution_id DESC\)/);
    expect(byName.timeline_executions_export_source_idx).toMatch(/UNIQUE INDEX .*\(project_id, space_id, \(\(input ->> 'sourceVersionId'::text\)\)\)/);
    expect(byName.timeline_executions_export_source_idx).toMatch(/web_animation_export/);
  });
});
