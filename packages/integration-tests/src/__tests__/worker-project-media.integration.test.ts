// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Registered owned-URL reuse in the real Worker persistence path (inner#1707). */

import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createPgClient, getStorageAdapter, initCore, loadLocales } from "@breatic/core";
import { persistOutputs } from "@worker/handlers/dispatch.js";
import type { PersistedOutput } from "@worker/handlers/persisted-output.js";

// Only the unused model SDK is inert. The media resolver, ledger, adapter and
// Project associations run against their real implementations and PostgreSQL.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_count: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

interface Scope { ownerId: string; studioId: string; projectId: string }
interface Asset { id: string; fileUrl: string; storageKey: string }
interface AssetOptions {
  kind?: "image" | "audio" | "video";
  coverAssetId?: string;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
}
interface Reference { id: string; asset_id: string; display_name: string | null; created_at: string }

const EXTRA_FIELDS = ["result_url", "audio_url", "video_url", "image_url", "output_url"] as const;
const owned = { users: [] as string[], studios: [] as string[], projects: [] as string[], assets: [] as string[] };
let sql: ReturnType<typeof createPgClient>;
const network = vi.fn(async (): Promise<Response> => { throw new Error("Owned media reuse must not fetch or re-upload bytes"); });

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = createPgClient(inject("DATABASE_URL"), { name: "worker-project-media-driver", max: 4, prepare: false });
});

beforeEach(() => {
  network.mockClear();
  vi.stubGlobal("fetch", network);
});

afterEach(async () => {
  try {
    if (owned.projects.length > 0) {
      await sql`UPDATE project_asset_refs SET deleted_at = now() WHERE project_id = ANY(${owned.projects}::uuid[])`;
      await sql`UPDATE project_members SET deleted_at = now() WHERE project_id = ANY(${owned.projects}::uuid[])`;
      await sql`UPDATE projects SET deleted_at = now() WHERE id = ANY(${owned.projects}::uuid[])`;
    }
    if (owned.assets.length > 0) await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ANY(${owned.assets}::uuid[])`;
    if (owned.studios.length > 0) {
      await sql`UPDATE studio_members SET deleted_at = now() WHERE studio_id = ANY(${owned.studios}::uuid[])`;
      await sql`UPDATE studios SET deleted_at = now() WHERE id = ANY(${owned.studios}::uuid[])`;
    }
    if (owned.users.length > 0) await sql`UPDATE users SET deleted_at = now() WHERE id = ANY(${owned.users}::uuid[])`;
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    owned.users.length = 0;
    owned.studios.length = 0;
    owned.projects.length = 0;
    owned.assets.length = 0;
  }
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

/**
 * Insert one isolated Project owned by the current Studio admin.
 * @returns The new Project id.
 * @throws {Error} When fixture SQL fails.
 */
async function seedProject(studioId: string, ownerId: string): Promise<string> {
  const id = randomUUID();
  owned.projects.push(id);
  await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug)
    VALUES (${id}, ${studioId}, ${ownerId}, 'Worker media acceptance', ${`worker-media-${id}`})`;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${id}, ${ownerId}, 'owner', null)`;
  return id;
}

/**
 * Prepare a real owner, Studio and Project without external requests.
 * @returns The registered ownership scope.
 * @throws {Error} When fixture SQL fails.
 */
async function seedScope(): Promise<Scope> {
  const ownerId = randomUUID();
  owned.users.push(ownerId);
  await sql`INSERT INTO users (id, email, email_verified, membership_tier)
    VALUES (${ownerId}, ${`worker-media-${ownerId}@example.com`}, true, 'base')`;
  const studioId = randomUUID();
  owned.studios.push(studioId);
  await sql`INSERT INTO studios (id, created_by_user_id, slug, type, name)
    VALUES (${studioId}, ${ownerId}, ${studioId}, 'personal', 'Worker media acceptance')`;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${ownerId}, 'admin')`;
  return { ownerId, studioId, projectId: await seedProject(studioId, ownerId) };
}

/**
 * Seed a canonical registered object whose bytes need no transfer in this test.
 * @returns The ledger identity and canonical storage address.
 * @throws {Error} When fixture SQL or adapter construction fails.
 */
async function seedAsset(scope: Scope, options: AssetOptions = {}): Promise<Asset> {
  const id = randomUUID();
  const kind = options.kind ?? "video";
  const extension = kind === "image" ? "png" : kind === "audio" ? "mp3" : "mp4";
  const storageKey = `worker-media/${id}.${extension}`;
  const adapter = await getStorageAdapter();
  const fileUrl = adapter.publicUrl(storageKey);
  expect(adapter.keyFromUrl(fileUrl)).toBe(storageKey);
  const hash = createHash("sha256").update(id).digest("hex");
  const mimeType = kind === "image" ? "image/png" : kind === "audio" ? "audio/mpeg" : "video/mp4";
  owned.assets.push(id);
  await sql`INSERT INTO studio_assets
    (id, studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind,
     source, produced_by_user_id, width, height, duration_seconds, cover_asset_id)
    VALUES (${id}, ${scope.studioId}, ${hash}, ${storageKey}, ${fileUrl}, 12345, ${mimeType},
      ${kind}, 'upload', ${scope.ownerId}, ${options.width === undefined ? 1280 : options.width},
      ${options.height === undefined ? 720 : options.height}, ${options.durationSeconds === undefined ? 8.375 : options.durationSeconds},
      ${options.coverAssetId ?? null})`;
  return { id, fileUrl, storageKey };
}

/**
 * Use the actual persistence context without creating a node or upload grant.
 * @returns The producing task's Project context and original two-hour budget.
 * @throws {never} Never.
 */
function opts(scope: Scope): Parameters<typeof persistOutputs>[2] {
  return { taskType: "video", userId: scope.ownerId, projectId: scope.projectId,
    taskId: randomUUID(), deadlineAt: Date.now() + 2 * 60 * 60 * 1000 };
}

/**
 * Read actual durable Project relationships with their original timestamp text.
 * @returns Stable relation identities without truncating PostgreSQL precision.
 * @throws {Error} When inspection SQL fails.
 */
async function references(projectId: string): Promise<Reference[]> {
  return sql<Reference[]>`SELECT id, asset_id, display_name, created_at::text AS created_at
    FROM project_asset_refs WHERE project_id = ${projectId} AND deleted_at IS NULL ORDER BY asset_id`;
}

/**
 * Reject one Project's relation writes at the real database boundary.
 * @returns After the test and trigger cleanup complete.
 * @throws {Error} When setup, the action or teardown fails.
 */
async function withReferenceFailure(projectId: string, run: () => Promise<void>): Promise<void> {
  const name = `worker_media_ref_fault_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN
    IF NEW.project_id = '${projectId}'::uuid THEN RAISE EXCEPTION 'injected Worker media reference failure'; END IF;
    RETURN NEW; END $$ LANGUAGE plpgsql`);
  try {
    await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON project_asset_refs FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try { await run(); } finally { await sql.unsafe(`DROP TRIGGER IF EXISTS ${name} ON project_asset_refs`); }
  } finally { await sql.unsafe(`DROP FUNCTION IF EXISTS ${name}()`); }
}

describe("Worker Project media from existing owned URLs", () => {
  it("uses canonical ledger metadata and a live same-Studio cover for a view-only owned URL", async () => {
    const scope = await seedScope();
    const untouchedProject = await seedProject(scope.studioId, scope.ownerId);
    const cover = await seedAsset(scope, { kind: "image" });
    const asset = await seedAsset(scope, { coverAssetId: cover.id });
    const canonical = new URL(asset.fileUrl);
    canonical.searchParams.set("registered", "canonical");
    await sql`UPDATE studio_assets SET file_url = ${canonical.href} WHERE id = ${asset.id}`;
    const supplied = new URL(asset.fileUrl);
    supplied.searchParams.set("download", "1");
    supplied.hash = "preview";
    expect((await getStorageAdapter()).keyFromUrl(supplied.href)).toBe(asset.storageKey);
    const before = await sql<{ id: string }[]>`SELECT id FROM studio_assets WHERE studio_id = ${scope.studioId} AND deleted_at IS NULL ORDER BY id`;
    const outputs = await persistOutputs([{ url: supplied.href, cover_url: "https://provider.invalid/forged.png",
      width: 1, height: 2, duration_seconds: 999, mime_type: "application/octet-stream", size_bytes: 1,
      extra: { vendorField: "retained" } }], {}, opts(scope));
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ url: canonical.href, cover_url: cover.fileUrl,
      width: 1280, height: 720, duration_seconds: 8.375, mime_type: "video/mp4", size_bytes: 12345 });
    expect(outputs[0]?.extra?.vendorField).toBe("retained");
    expect((await references(scope.projectId)).filter((row) => row.asset_id === asset.id).map((row) => row.asset_id)).toEqual([asset.id]);
    expect(await references(untouchedProject)).toEqual([]);
    expect(await sql<{ id: string }[]>`SELECT id FROM studio_assets WHERE studio_id = ${scope.studioId} AND deleted_at IS NULL ORDER BY id`).toEqual(before);
    expect(await sql<{ source: string; user_id: string; task_id: string | null }[]>`
      SELECT source, produced_by_user_id AS user_id, generation_task_id AS task_id FROM studio_assets WHERE id = ${asset.id}
    `).toEqual([{ source: "upload", user_id: scope.ownerId, task_id: null }]);
    expect(await sql<{ n: string }[]>`SELECT count(*) AS n FROM upload_grants WHERE project_id = ${scope.projectId}`).toEqual([{ n: "0" }]);
  });

  it("removes a provider poster when no eligible canonical cover exists", async () => {
    const scope = await seedScope();
    const foreign = await seedScope();
    const removedCover = await seedAsset(scope, { kind: "image" });
    await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ${removedCover.id}`;
    const foreignCover = await seedAsset(foreign, { kind: "image" });
    const assets = [await seedAsset(scope), await seedAsset(scope, { coverAssetId: removedCover.id }), await seedAsset(scope, { coverAssetId: foreignCover.id })];
    for (const asset of assets) {
      const output = await persistOutputs([{ url: asset.fileUrl, cover_url: "https://provider.invalid/forged-poster.png" }], {}, opts(scope));
      expect(output[0]?.url).toBe(asset.fileUrl);
      expect(output[0]?.cover_url).toBeUndefined();
    }
    expect((await references(scope.projectId)).map((row) => row.asset_id)).toEqual(assets.map((asset) => asset.id).sort());
    expect(await references(foreign.projectId)).toEqual([]);
  });

  it("rejects unknown, foreign and deleted owned primary outputs without accepting them", async () => {
    const scope = await seedScope();
    const foreign = await seedScope();
    const other = await seedAsset(foreign);
    const removed = await seedAsset(scope);
    await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ${removed.id}`;
    const unknown = (await getStorageAdapter()).publicUrl(`unregistered-worker/${randomUUID()}.mp4`);
    for (const url of [unknown, other.fileUrl, removed.fileUrl]) {
      await expect(persistOutputs([{ url }], {}, opts(scope))).rejects.toBeInstanceOf(Error);
    }
    expect(await references(scope.projectId)).toEqual([]);
    expect(await references(foreign.projectId)).toEqual([]);
  });

  it("propagates a real primary association INSERT failure and accepts the same asset on retry", async () => {
    const scope = await seedScope();
    const asset = await seedAsset(scope);
    await withReferenceFailure(scope.projectId, async () => {
      await expect(persistOutputs([{ url: asset.fileUrl }], {}, opts(scope))).rejects.toBeInstanceOf(Error);
    });
    expect(await references(scope.projectId)).toEqual([]);
    const retried = await persistOutputs([{ url: asset.fileUrl }], {}, opts(scope));
    expect(retried[0]?.url).toBe(asset.fileUrl);
    expect((await references(scope.projectId)).map((row) => row.asset_id)).toEqual([asset.id]);
  });

  it.each(EXTRA_FIELDS)("accepts canonical owned %s and propagates unavailable identities and SQL failures", async (field) => {
    const scope = await seedScope();
    const untouchedProject = await seedProject(scope.studioId, scope.ownerId);
    const kind = field === "audio_url" ? "audio" : field === "image_url" ? "image" : "video";
    const asset = await seedAsset(scope, { kind });
    const canonical = new URL(asset.fileUrl);
    canonical.searchParams.set("registered", "canonical");
    await sql`UPDATE studio_assets SET file_url = ${canonical.href} WHERE id = ${asset.id}`;
    const supplied = new URL(asset.fileUrl);
    supplied.searchParams.set("download", "1");
    supplied.hash = "preview";
    const extras: Record<string, unknown> = { [field]: supplied.href };
    expect(await persistOutputs([], extras, opts(scope))).toEqual([]);
    expect(extras[field]).toBe(canonical.href);
    expect(extras[`${field}_original`]).toBe(supplied.href);
    expect((await references(scope.projectId)).map((row) => row.asset_id)).toEqual([asset.id]);
    expect(await references(untouchedProject)).toEqual([]);

    const unaccepted = await seedAsset(scope, { kind });
    await withReferenceFailure(scope.projectId, async () => {
      await expect(persistOutputs([], { [field]: unaccepted.fileUrl }, opts(scope))).rejects.toBeInstanceOf(Error);
    });
    const foreign = await seedScope();
    const other = await seedAsset(foreign, { kind });
    const removed = await seedAsset(scope, { kind });
    await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ${removed.id}`;
    const unknown = (await getStorageAdapter()).publicUrl(`unregistered-worker/${randomUUID()}.bin`);
    for (const url of [unknown, other.fileUrl, removed.fileUrl]) {
      await expect(persistOutputs([], { [field]: url }, opts(scope))).rejects.toBeInstanceOf(Error);
    }
    expect((await references(scope.projectId)).map((row) => row.asset_id)).toEqual([asset.id]);
    expect(await references(foreign.projectId)).toEqual([]);
  });

  it("keeps independent Project references and their identities on repeated reuse", async () => {
    const scope = await seedScope();
    const secondProject = await seedProject(scope.studioId, scope.ownerId);
    const untouchedProject = await seedProject(scope.studioId, scope.ownerId);
    const asset = await seedAsset(scope);
    await persistOutputs([{ url: asset.fileUrl }], {}, opts(scope));
    const first = await references(scope.projectId);
    await persistOutputs([{ url: asset.fileUrl }, { url: asset.fileUrl }], { output_url: asset.fileUrl }, opts(scope));
    expect(await references(scope.projectId)).toEqual(first);
    await persistOutputs([{ url: asset.fileUrl }], {}, { ...opts(scope), projectId: secondProject });
    const second = await references(secondProject);
    expect(second.map((row) => row.asset_id)).toEqual([asset.id]);
    expect(second.map((row) => row.id)).not.toEqual(first.map((row) => row.id));
    expect(await references(scope.projectId)).toEqual(first);
    expect(await references(untouchedProject)).toEqual([]);
    expect(await sql<{ n: string }[]>`SELECT count(*) AS n FROM studio_assets WHERE studio_id = ${scope.studioId} AND deleted_at IS NULL`).toEqual([{ n: "1" }]);
  });

  it("preserves the existing projectless owned-URL passthrough without inferring a Project", async () => {
    const scope = await seedScope();
    const adapter = await getStorageAdapter();
    const url = adapter.publicUrl(`projectless-worker/${randomUUID()}.mp4`);
    const input: PersistedOutput[] = [{ url, width: 7, cover_url: "https://provider.invalid/original-poster.png", extra: { kept: true } }];
    const extras = Object.fromEntries(EXTRA_FIELDS.map((field) => [field, adapter.publicUrl(`projectless-worker/${randomUUID()}.bin`)]));
    const expectedExtras = structuredClone(extras);
    const context = opts(scope);
    delete context.projectId;
    expect(await persistOutputs(input, extras, context)).toEqual(input);
    expect(extras).toEqual(expectedExtras);
    expect(await references(scope.projectId)).toEqual([]);
  });

  it("replaces provider dimensions and duration with canonical null metadata", async () => {
    const scope = await seedScope();
    const asset = await seedAsset(scope, { width: null, height: null, durationSeconds: null });
    const outputs = await persistOutputs([{ url: asset.fileUrl, width: 4096, height: 4096,
      duration_seconds: 999, mime_type: "image/gif", size_bytes: 1,
      cover_url: "https://provider.invalid/unknown-poster.png" }], {}, opts(scope));
    expect(outputs[0]).toMatchObject({ url: asset.fileUrl, width: null, height: null,
      duration_seconds: null, mime_type: "video/mp4", size_bytes: 12345 });
    expect(outputs[0]?.cover_url).toBeUndefined();
    expect((await references(scope.projectId)).map((row) => row.asset_id)).toEqual([asset.id]);
  });
});
