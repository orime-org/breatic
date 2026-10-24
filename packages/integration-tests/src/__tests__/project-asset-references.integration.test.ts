// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Project-scoped registered media contracts (inner#1707).
 *
 * These tests exercise the real business database and authorization service.
 * The fixture connection is separate from core's application pool; the gate
 * connection holds an uncommitted unique-key competitor until both real
 * registration calls are observed waiting in PostgreSQL.
 */

import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createPgClient,
  db,
  ForbiddenError,
  initCore,
  loadLocales,
  NotFoundError,
  projectAssetReferenceService,
} from "@breatic/core";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

interface ProjectFixture {
  ownerId: string;
  studioId: string;
  projectId: string;
}

interface AssetFixture {
  id: string;
  fileUrl: string;
  kind: "video" | "image";
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  mimeType: string;
  sizeBytes: number;
}

interface AssetOptions {
  kind?: "video" | "image";
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  coverAssetId?: string;
}

interface ReferenceRow {
  id: string;
  project_id: string;
  asset_id: string;
  display_name: string | null;
  created_at: string;
}

let sql: ReturnType<typeof createPgClient>;
const owned = {
  users: [] as string[],
  studios: [] as string[],
  projects: [] as string[],
  assets: [] as string[],
};

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = createPgClient(inject("DATABASE_URL"), {
    name: "project-asset-reference-test-driver",
    max: 4,
    prepare: false,
  });
});

afterEach(async () => {
  try {
    if (owned.projects.length > 0) {
      await sql`UPDATE project_asset_refs SET deleted_at = now()
        WHERE project_id = ANY(${owned.projects}::uuid[])`;
      await sql`UPDATE project_members SET deleted_at = now()
        WHERE project_id = ANY(${owned.projects}::uuid[])`;
      await sql`UPDATE projects SET deleted_at = now()
        WHERE id = ANY(${owned.projects}::uuid[])`;
    }
    if (owned.assets.length > 0) {
      await sql`UPDATE studio_assets SET deleted_at = now()
        WHERE id = ANY(${owned.assets}::uuid[])`;
    }
    if (owned.studios.length > 0) {
      await sql`UPDATE studio_members SET deleted_at = now()
        WHERE studio_id = ANY(${owned.studios}::uuid[])`;
      await sql`UPDATE studios SET deleted_at = now()
        WHERE id = ANY(${owned.studios}::uuid[])`;
    }
    if (owned.users.length > 0) {
      await sql`UPDATE users SET deleted_at = now()
        WHERE id = ANY(${owned.users}::uuid[])`;
    }
  } finally {
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
 * Insert a uniquely identified test user.
 * @returns The new user's id.
 * @throws {Error} When the fixture database write fails.
 */
async function seedUser(): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO users (id, email, email_verified)
    VALUES (${id}, ${`timeline-asset-${id}@example.com`}, true)`;
  owned.users.push(id);
  return id;
}

/**
 * Insert a Project in an existing Studio with an active owner membership.
 * @returns The new Project id.
 * @throws {Error} When a fixture database write fails.
 */
async function seedProject(studioId: string, ownerId: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug)
    VALUES (${id}, ${studioId}, ${ownerId}, 'Timeline media test', ${`media-${id}`})`;
  owned.projects.push(id);
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${id}, ${ownerId}, 'owner', null)`;
  return id;
}

/**
 * Insert one owner, their Studio, and an owned Project.
 * @returns The isolated authorization fixture.
 * @throws {Error} When a fixture database write fails.
 */
async function seedFixture(): Promise<ProjectFixture> {
  const ownerId = await seedUser();
  const studioId = randomUUID();
  await sql`INSERT INTO studios (id, created_by_user_id, slug, type, name)
    VALUES (${studioId}, ${ownerId}, ${studioId}, 'personal', 'Timeline media studio')`;
  owned.studios.push(studioId);
  await sql`INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${ownerId}, 'admin')`;
  const projectId = await seedProject(studioId, ownerId);
  return { ownerId, studioId, projectId };
}

/**
 * Insert a registered physical media row without making network requests.
 * @returns The canonical media facts written to the ledger.
 * @throws {Error} When the fixture database write fails.
 */
async function seedAsset(
  fixture: ProjectFixture,
  options: AssetOptions = {},
): Promise<AssetFixture> {
  const id = randomUUID();
  const kind = options.kind ?? "video";
  const storageKey = `test-media/${id}.${kind === "video" ? "mp4" : "png"}`;
  const asset: AssetFixture = {
    id,
    fileUrl: `https://assets.test.invalid/${storageKey}`,
    kind,
    width: options.width === undefined ? 1920 : options.width,
    height: options.height === undefined ? 1080 : options.height,
    durationSeconds: options.durationSeconds === undefined ? 5.125 : options.durationSeconds,
    mimeType: kind === "video" ? "video/mp4" : "image/png",
    sizeBytes: 8192,
  };
  const hash = createHash("sha256").update(id).digest("hex");
  await sql`INSERT INTO studio_assets
    (id, studio_id, content_hash, storage_key, file_url, size_bytes, mime_type,
     kind, source, produced_by_user_id, width, height, duration_seconds, cover_asset_id)
    VALUES (${id}, ${fixture.studioId}, ${hash}, ${storageKey}, ${asset.fileUrl},
      ${asset.sizeBytes}, ${asset.mimeType}, ${kind}, 'upload', ${fixture.ownerId},
      ${asset.width}, ${asset.height}, ${asset.durationSeconds}, ${options.coverAssetId ?? null})`;
  owned.assets.push(id);
  return asset;
}

/**
 * Read a Project's actual live association rows at PostgreSQL precision.
 * @returns The persisted association facts.
 * @throws {Error} When the fixture database read fails.
 */
async function liveReferences(projectId: string): Promise<ReferenceRow[]> {
  return sql<ReferenceRow[]>`SELECT id, project_id, asset_id, display_name,
      created_at::text AS created_at
    FROM project_asset_refs
    WHERE project_id = ${projectId} AND deleted_at IS NULL
    ORDER BY id`;
}

describe("Project registered asset references", () => {
  it("keeps one persisted identity, first name, and first timestamp on repeated association", async () => {
    const fixture = await seedFixture();
    const asset = await seedAsset(fixture);
    const input = { projectId: fixture.projectId, assetIds: [asset.id] };
    const first = await projectAssetReferenceService.recordProjectAssetReferences({
      ...input, displayNames: { [asset.id]: "First video.mp4" },
    });
    const before = await liveReferences(fixture.projectId);
    const repeated = await projectAssetReferenceService.recordProjectAssetReferences({
      ...input, assetIds: [asset.id, asset.id], displayNames: { [asset.id]: "Renamed.mp4" },
    });
    const after = await liveReferences(fixture.projectId);
    expect(first).toHaveLength(1);
    expect(repeated).toHaveLength(1);
    expect(after).toEqual(before);
    expect(after).toEqual([{
      id: first[0]!.id,
      project_id: fixture.projectId,
      asset_id: asset.id,
      display_name: "First video.mp4",
      created_at: before[0]!.created_at,
    }]);
    expect(repeated[0]!.id).toBe(first[0]!.id);
  });

  it("converges two genuinely competing registrations on one live unique relation", async () => {
    const fixture = await seedFixture();
    const asset = await seedAsset(fixture);
    const gate = createPgClient(inject("DATABASE_URL"), {
      name: "project-asset-reference-unique-gate", max: 1, prepare: false,
    });
    try {
      await gate`BEGIN`;
      await gate`INSERT INTO project_asset_refs (id, project_id, asset_id)
        VALUES (${randomUUID()}, ${fixture.projectId}, ${asset.id})`;
      const input = { projectId: fixture.projectId, assetIds: [asset.id] };
      const registrations = Promise.allSettled([
        projectAssetReferenceService.recordProjectAssetReferences(input),
        projectAssetReferenceService.recordProjectAssetReferences(input),
      ]);
      let probeError: unknown;
      try {
        await waitUntilBlockedOn(sql, ["insert", "project_asset_refs"], 2);
      } catch (error) {
        probeError = error;
      } finally {
        await gate`ROLLBACK`;
      }
      const settled = await registrations;
      if (probeError !== undefined) throw probeError;
      expect(settled.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
      const rows = await liveReferences(fixture.projectId);
      expect(rows).toHaveLength(1);
      for (const entry of settled) {
        if (entry.status !== "fulfilled") throw entry.reason;
        expect(entry.value).toHaveLength(1);
        expect(entry.value[0]!.id).toBe(rows[0]!.id);
      }
    } finally {
      await gate.end({ timeout: 1 });
    }
  });

  it("joins the caller transaction so rollback leaves no association", async () => {
    const fixture = await seedFixture();
    const asset = await seedAsset(fixture);
    const rollback = new Error("rollback association fixture");
    await expect(db.transaction(async (tx) => {
      await projectAssetReferenceService.recordProjectAssetReferences({
        projectId: fixture.projectId, assetIds: [asset.id],
      }, tx);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await liveReferences(fixture.projectId)).toEqual([]);
  });

  it("keeps two same-Studio Projects independent while reusing one registered asset", async () => {
    const fixture = await seedFixture();
    const otherProjectId = await seedProject(fixture.studioId, fixture.ownerId);
    const asset = await seedAsset(fixture);
    const first = await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: fixture.projectId, assetIds: [asset.id],
    });
    await expect(projectAssetReferenceService.resolveProjectAsset({
      projectId: otherProjectId, assetId: asset.id, userId: fixture.ownerId,
    })).rejects.toBeInstanceOf(NotFoundError);
    const second = await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: otherProjectId, assetIds: [asset.id],
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.id).not.toBe(second[0]!.id);
    const resolved = await projectAssetReferenceService.resolveProjectAsset({
      projectId: otherProjectId, assetId: asset.id, userId: fixture.ownerId,
    });
    expect(resolved).toMatchObject({ assetId: asset.id, projectReferenceId: second[0]!.id, fileUrl: asset.fileUrl });
    const ledger = await sql<{ id: string }[]>`SELECT id FROM studio_assets WHERE id = ${asset.id}`;
    expect(ledger).toEqual([{ id: asset.id }]);
  });

  it("refuses a different-Studio asset without partially registering the batch", async () => {
    const fixture = await seedFixture();
    const foreign = await seedFixture();
    const localAsset = await seedAsset(fixture);
    const foreignAsset = await seedAsset(foreign);
    await expect(projectAssetReferenceService.recordProjectAssetReferences({
      projectId: fixture.projectId, assetIds: [localAsset.id, foreignAsset.id],
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(await liveReferences(fixture.projectId)).toEqual([]);
  });

  it("does not expose a different-Studio asset even when a persisted relation names it", async () => {
    const fixture = await seedFixture();
    const foreign = await seedFixture();
    const foreignAsset = await seedAsset(foreign);
    await sql`INSERT INTO project_asset_refs (id, project_id, asset_id)
      VALUES (${randomUUID()}, ${fixture.projectId}, ${foreignAsset.id})`;
    await expect(projectAssetReferenceService.resolveProjectAsset({
      projectId: fixture.projectId, assetId: foreignAsset.id, userId: fixture.ownerId,
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(await projectAssetReferenceService.listProjectVideos({
      projectId: fixture.projectId, userId: fixture.ownerId,
    })).toEqual({ items: [], nextCursor: null });
  });

  it("allows an invited Project Viewer who has no Studio membership to read canonical media", async () => {
    const fixture = await seedFixture();
    const viewerId = await seedUser();
    const asset = await seedAsset(fixture);
    await sql`INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${fixture.projectId}, ${viewerId}, 'viewer', ${fixture.ownerId})`;
    const refs = await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: fixture.projectId, assetIds: [asset.id], displayNames: { [asset.id]: "Invite video.mp4" },
    });
    expect(await sql`SELECT user_id FROM studio_members WHERE user_id = ${viewerId}`).toEqual([]);
    const resolved = await projectAssetReferenceService.resolveProjectAsset({
      projectId: fixture.projectId, assetId: asset.id, userId: viewerId,
    });
    expect(resolved).toMatchObject({
      assetId: asset.id, projectReferenceId: refs[0]!.id, displayName: "Invite video.mp4",
      kind: "video", fileUrl: asset.fileUrl, coverUrl: null,
      width: 1920, height: 1080, durationSeconds: 5.125, mimeType: "video/mp4", sizeBytes: 8192,
    });
    const page = await projectAssetReferenceService.listProjectVideos({
      projectId: fixture.projectId, userId: viewerId,
    });
    expect(page.items).toEqual([resolved]);
    expect(page.nextCursor).toBeNull();
  });

  it("refuses both single-asset and list reads to a non-member", async () => {
    const fixture = await seedFixture();
    const outsiderId = await seedUser();
    const asset = await seedAsset(fixture);
    await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: fixture.projectId, assetIds: [asset.id],
    });
    await expect(projectAssetReferenceService.resolveProjectAsset({
      projectId: fixture.projectId, assetId: asset.id, userId: outsiderId,
    })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(projectAssetReferenceService.listProjectVideos({
      projectId: fixture.projectId, userId: outsiderId,
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("uses current membership after a formerly authorized Viewer is removed", async () => {
    const fixture = await seedFixture();
    const viewerId = await seedUser();
    const asset = await seedAsset(fixture);
    await sql`INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${fixture.projectId}, ${viewerId}, 'viewer', ${fixture.ownerId})`;
    await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: fixture.projectId, assetIds: [asset.id],
    });
    const before = await projectAssetReferenceService.resolveProjectAsset({
      projectId: fixture.projectId, assetId: asset.id, userId: viewerId,
    });
    expect(before.assetId).toBe(asset.id);
    await sql`UPDATE project_members SET deleted_at = now()
      WHERE project_id = ${fixture.projectId} AND user_id = ${viewerId}`;
    await expect(projectAssetReferenceService.resolveProjectAsset({
      projectId: fixture.projectId, assetId: asset.id, userId: viewerId,
    })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(projectAssetReferenceService.listProjectVideos({
      projectId: fixture.projectId, userId: viewerId,
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(["project", "studio"] as const)("refuses reads when the owning %s is soft-deleted", async (scope) => {
    const fixture = await seedFixture();
    const asset = await seedAsset(fixture);
    await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: fixture.projectId, assetIds: [asset.id],
    });
    if (scope === "project") await sql`UPDATE projects SET deleted_at = now() WHERE id = ${fixture.projectId}`;
    else await sql`UPDATE studios SET deleted_at = now() WHERE id = ${fixture.studioId}`;
    await expect(projectAssetReferenceService.resolveProjectAsset({
      projectId: fixture.projectId, assetId: asset.id, userId: fixture.ownerId,
    })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(projectAssetReferenceService.listProjectVideos({
      projectId: fixture.projectId, userId: fixture.ownerId,
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(["asset", "reference"] as const)("excludes a soft-deleted %s from both read paths", async (scope) => {
    const fixture = await seedFixture();
    const asset = await seedAsset(fixture);
    const refs = await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: fixture.projectId, assetIds: [asset.id],
    });
    if (scope === "asset") await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ${asset.id}`;
    else await sql`UPDATE project_asset_refs SET deleted_at = now() WHERE id = ${refs[0]!.id}`;
    await expect(projectAssetReferenceService.resolveProjectAsset({
      projectId: fixture.projectId, assetId: asset.id, userId: fixture.ownerId,
    })).rejects.toBeInstanceOf(NotFoundError);
    const page = await projectAssetReferenceService.listProjectVideos({
      projectId: fixture.projectId, userId: fixture.ownerId,
    });
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it("resolves current ledger metadata and a live cover without copying stale facts into the relation", async () => {
    const fixture = await seedFixture();
    const cover = await seedAsset(fixture, { kind: "image", durationSeconds: null });
    const asset = await seedAsset(fixture, { coverAssetId: cover.id });
    await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: fixture.projectId, assetIds: [asset.id],
    });
    await sql`UPDATE studio_assets SET width = 1280, height = 720, duration_seconds = 7.375
      WHERE id = ${asset.id}`;
    const input = { projectId: fixture.projectId, assetId: asset.id, userId: fixture.ownerId };
    const resolved = await projectAssetReferenceService.resolveProjectAsset(input);
    expect(resolved).toMatchObject({
      assetId: asset.id, fileUrl: asset.fileUrl, coverUrl: cover.fileUrl,
      width: 1280, height: 720, durationSeconds: 7.375,
    });
    await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ${cover.id}`;
    expect(await projectAssetReferenceService.resolveProjectAsset(input)).toMatchObject({
      assetId: asset.id, coverUrl: null, width: 1280, height: 720, durationSeconds: 7.375,
    });
  });

  it("preserves unknown metadata as null for both list and single-asset reads", async () => {
    const fixture = await seedFixture();
    const asset = await seedAsset(fixture, { width: null, height: null, durationSeconds: null });
    await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: fixture.projectId, assetIds: [asset.id],
    });
    const resolved = await projectAssetReferenceService.resolveProjectAsset({
      projectId: fixture.projectId, assetId: asset.id, userId: fixture.ownerId,
    });
    expect(resolved).toMatchObject({ assetId: asset.id, width: null, height: null, durationSeconds: null });
    const page = await projectAssetReferenceService.listProjectVideos({
      projectId: fixture.projectId, userId: fixture.ownerId,
    });
    expect(page.items).toEqual([resolved]);
  });

  it("lists only live registered videos associated with the requested Project", async () => {
    const fixture = await seedFixture();
    const otherProjectId = await seedProject(fixture.studioId, fixture.ownerId);
    const video = await seedAsset(fixture);
    const image = await seedAsset(fixture, { kind: "image", durationSeconds: null });
    const unassociated = await seedAsset(fixture);
    await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: fixture.projectId, assetIds: [video.id, image.id],
    });
    await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: otherProjectId, assetIds: [unassociated.id],
    });
    const page = await projectAssetReferenceService.listProjectVideos({
      projectId: fixture.projectId, userId: fixture.ownerId,
    });
    expect(page.items.map((item) => item.assetId)).toEqual([video.id]);
    expect(page.nextCursor).toBeNull();
  });

  it("continues through microseconds and equal-timestamp UUID ties without missing or repeating media", async () => {
    const fixture = await seedFixture();
    const first = await seedAsset(fixture);
    const second = await seedAsset(fixture);
    const tieHigh = await seedAsset(fixture);
    const tieLow = await seedAsset(fixture);
    const idPrefix = randomUUID().slice(0, 24);
    const ordered = [
      { asset: first, id: `${idPrefix}000000000001`, at: "2026-10-24 12:00:00.000003+00" },
      { asset: second, id: `${idPrefix}000000000002`, at: "2026-10-24 12:00:00.000002+00" },
      { asset: tieHigh, id: `${idPrefix}000000000004`, at: "2026-10-24 12:00:00.000001+00" },
      { asset: tieLow, id: `${idPrefix}000000000003`, at: "2026-10-24 12:00:00.000001+00" },
    ];
    for (const entry of ordered) {
      await projectAssetReferenceService.recordProjectAssetReferences({
        projectId: fixture.projectId, assetIds: [entry.asset.id],
      });
      // Keep the parameter text-typed: the driver's timestamp serializer goes
      // through Date and would erase the microseconds this fixture must retain.
      await sql`UPDATE project_asset_refs SET id = ${entry.id}, created_at = ${entry.at}::text::timestamptz
        WHERE project_id = ${fixture.projectId} AND asset_id = ${entry.asset.id} AND deleted_at IS NULL`;
    }
    const persisted = await sql<{ id: string; asset_id: string; created_at: string }[]>`
      SELECT refs.id, refs.asset_id, refs.created_at::text AS created_at
      FROM project_asset_refs AS refs
      WHERE refs.project_id = ${fixture.projectId} AND refs.deleted_at IS NULL
      ORDER BY refs.created_at DESC, refs.id DESC
    `;
    expect(persisted).toEqual(ordered.map((entry) => ({
      id: entry.id,
      asset_id: entry.asset.id,
      created_at: entry.at,
    })));
    let cursor: string | undefined;
    const seen: string[] = [];
    for (let index = 0; index < ordered.length; index += 1) {
      const page = await projectAssetReferenceService.listProjectVideos({
        projectId: fixture.projectId, userId: fixture.ownerId, limit: 1, cursor,
      });
      expect(page.items.map((item) => item.assetId)).toEqual([ordered[index]!.asset.id]);
      seen.push(...page.items.map((item) => item.assetId));
      if (index < ordered.length - 1) expect(page.nextCursor).toEqual(expect.any(String));
      else expect(page.nextCursor).toBeNull();
      cursor = page.nextCursor ?? undefined;
    }
    expect(seen).toEqual(ordered.map((entry) => entry.asset.id));
    expect(new Set(seen).size).toBe(4);
  });
});
