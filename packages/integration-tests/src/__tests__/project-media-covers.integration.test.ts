// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The Project media list never shows a video cover (inner#2171 design §5.7): a cover keeps its relation row if one
 * was written before, the list query leaves it out, a video still shows its cover address, and pages neither miss
 * nor repeat the rest.
 */

import { createHash, randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, getStorageAdapter, initCore, loadLocales, projectAssetReferenceService } from "@breatic/core";

interface Fixture { ownerId: string; studioId: string; projectId: string }
type Kind = "image" | "video" | "audio";
type Source = "upload" | "cover" | "generated";

let sql: ReturnType<typeof createPgClient>;
const owned = { users: [] as string[], studios: [] as string[], projects: [] as string[], assets: [] as string[] };

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = createPgClient(inject("DATABASE_URL"), { name: "project-media-covers-test-driver", max: 2, prepare: false });
});

afterEach(async () => {
  await sql`UPDATE project_asset_refs SET deleted_at = now() WHERE project_id = ANY(${owned.projects}::uuid[])`;
  await sql`UPDATE project_members SET deleted_at = now() WHERE project_id = ANY(${owned.projects}::uuid[])`;
  await sql`UPDATE projects SET deleted_at = now() WHERE id = ANY(${owned.projects}::uuid[])`;
  await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ANY(${owned.assets}::uuid[])`;
  await sql`UPDATE studio_members SET deleted_at = now() WHERE studio_id = ANY(${owned.studios}::uuid[])`;
  await sql`UPDATE studios SET deleted_at = now() WHERE id = ANY(${owned.studios}::uuid[])`;
  await sql`UPDATE users SET deleted_at = now() WHERE id = ANY(${owned.users}::uuid[])`;
  for (const list of Object.values(owned)) list.length = 0;
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

/**
 * Insert an owner, their Studio and a Project they own.
 * @returns The fixture ids.
 * @throws {Error} When a fixture write fails.
 */
async function seedFixture(): Promise<Fixture> {
  const ownerId = randomUUID();
  await sql`INSERT INTO users (id, email, email_verified) VALUES (${ownerId}, ${`media-cover-${ownerId}@example.com`}, true)`;
  owned.users.push(ownerId);
  const studioId = randomUUID();
  await sql`INSERT INTO studios (id, created_by_user_id, slug, type, name) VALUES (${studioId}, ${ownerId}, ${studioId}, 'personal', 'Covers')`;
  owned.studios.push(studioId);
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${ownerId}, 'admin')`;
  const projectId = randomUUID();
  await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug) VALUES (${projectId}, ${studioId}, ${ownerId}, 'Covers', ${`covers-${projectId}`})`;
  owned.projects.push(projectId);
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${ownerId}, 'owner', null)`;
  return { ownerId, studioId, projectId };
}

/**
 * Insert one registered asset and relate it to the Project.
 * @returns The asset id and address.
 * @throws {Error} When a fixture write fails.
 */
async function seedAsset(fixture: Fixture, kind: Kind, source: Source, options: { cover?: string; related?: boolean } = {}): Promise<{ id: string; fileUrl: string }> {
  const id = randomUUID();
  const storageKey = `test-media/${id}.${kind === "video" ? "mp4" : kind === "audio" ? "mp3" : "jpg"}`;
  const fileUrl = (await getStorageAdapter()).publicUrl(storageKey);
  const mime = kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/jpeg";
  await sql`INSERT INTO studio_assets
    (id, studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id, width, height, duration_seconds, cover_asset_id)
    VALUES (${id}, ${fixture.studioId}, ${createHash("sha256").update(id).digest("hex")}, ${storageKey}, ${fileUrl}, 4096, ${mime}, ${kind}, ${source},
      ${fixture.ownerId}, ${kind === "audio" ? null : 640}, ${kind === "audio" ? null : 360}, ${kind === "image" ? null : 3}, ${options.cover ?? null})`;
  owned.assets.push(id);
  if (options.related !== false) {
    await sql`INSERT INTO project_asset_refs (id, project_id, asset_id) VALUES (${randomUUID()}, ${fixture.projectId}, ${id})`;
  }
  return { id, fileUrl };
}

/**
 * Read every page of the Project media list.
 * @returns Every listed asset id in page order.
 * @throws {Error} When a read fails.
 */
async function readAll(fixture: Fixture, kind: "image" | "video", limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await projectAssetReferenceService.listProjectMedia({ projectId: fixture.projectId, userId: fixture.ownerId, kind, limit, cursor });
    ids.push(...page.items.map((item) => item.assetId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return ids;
}

describe("Project media list without video covers (inner#2171 design §5.7)", () => {
  it("leaves out a cover that already has a relation row, and keeps the row", async () => {
    const fixture = await seedFixture();
    const cover = await seedAsset(fixture, "image", "cover");
    const picture = await seedAsset(fixture, "image", "upload");
    expect(await readAll(fixture, "image", 10)).toEqual([picture.id]);
    const [row] = await sql<Array<{ deleted_at: string | null }>>`SELECT deleted_at FROM project_asset_refs WHERE project_id = ${fixture.projectId} AND asset_id = ${cover.id}`;
    expect(row?.deleted_at).toBeNull();
  });

  it("still lists a video with its cover address", async () => {
    const fixture = await seedFixture();
    const cover = await seedAsset(fixture, "image", "cover");
    const video = await seedAsset(fixture, "video", "upload", { cover: cover.id });
    const page = await projectAssetReferenceService.listProjectMedia({ projectId: fixture.projectId, userId: fixture.ownerId, kind: "video" });
    expect(page.items.map((item) => [item.assetId, item.coverUrl])).toEqual([[video.id, cover.fileUrl]]);
  });

  it("does not let a cover take a place on a page", async () => {
    const fixture = await seedFixture();
    const first = await seedAsset(fixture, "image", "upload");
    await seedAsset(fixture, "image", "cover");
    const last = await seedAsset(fixture, "image", "upload");
    const listed = await readAll(fixture, "image", 1);
    expect(listed.sort()).toEqual([first.id, last.id].sort());
  });

  it("lists every related non-cover asset of the kind exactly once over any page size", async () => {
    const asset = fc.record({ kind: fc.constantFrom<Kind>("image", "video", "audio"), source: fc.constantFrom<Source>("upload", "cover", "generated"), related: fc.boolean() });
    await fc.assert(fc.asyncProperty(fc.array(asset, { maxLength: 8 }), fc.integer({ min: 1, max: 4 }), fc.constantFrom<"image" | "video">("image", "video"), async (assets, limit, kind) => {
      const fixture = await seedFixture();
      const seeded = [];
      for (const spec of assets) seeded.push({ ...spec, ...(await seedAsset(fixture, spec.kind, spec.source, { related: spec.related })) });
      const expected = seeded.filter((item) => item.related && item.kind === kind && item.source !== "cover").map((item) => item.id).sort();
      const listed = await readAll(fixture, kind, limit);
      expect(new Set(listed).size).toBe(listed.length);
      expect([...listed].sort()).toEqual(expected);
    }), { numRuns: 100 });
  });
});
