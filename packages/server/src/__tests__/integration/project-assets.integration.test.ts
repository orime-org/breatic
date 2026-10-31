// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Project media HTTP contracts backed by real PostgreSQL and Redis (inner#1707). */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createPgClient,
  getRedis,
  getStorageAdapter,
  getTimelineConfig,
  initCore,
  loadLocales,
  projectAssetReferenceService,
  revokeSession,
  sessionCookieName,
  setSession,
} from "@breatic/core";
import type { ProjectAssetPage, ProjectRegisteredAsset } from "@breatic/shared";

// The app imports provider entry points; these endpoints never invoke a model.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

interface Fixture {
  ownerId: string;
  studioId: string;
  projectId: string;
  cookie: string;
}

interface AssetFixture {
  id: string;
  fileUrl: string;
  kind: "image" | "video";
}

let sql: ReturnType<typeof createPgClient>;
let app: Hono;
const owned = {
  users: [] as string[],
  studios: [] as string[],
  projects: [] as string[],
  assets: [] as string[],
  tokens: [] as string[],
};

beforeAll(async () => {
  initCore(process.env);
  loadLocales();
  sql = createPgClient(inject("DATABASE_URL"), {
    name: "project-media-http-test-driver", max: 2, prepare: false,
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterEach(async () => {
  try {
    for (const token of owned.tokens) await revokeSession(getRedis(), token);
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
  } finally {
    for (const ids of Object.values(owned)) ids.length = 0;
  }
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

/**
 * Create an isolated account without bypassing request authentication.
 * @returns The persisted user id.
 * @throws {Error} When PostgreSQL rejects the fixture.
 */
async function seedUser(): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO users (id, email, email_verified)
    VALUES (${id}, ${`project-media-${id}@example.com`}, true)`;
  owned.users.push(id);
  return id;
}

/**
 * Create a real Redis session consumed by the app's authentication middleware.
 * @returns The request cookie.
 * @throws {Error} When Redis rejects the session.
 */
async function loginCookie(userId: string): Promise<string> {
  const token = randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  owned.tokens.push(token);
  return `${sessionCookieName()}=${token}`;
}

/**
 * Create one live Studio and an owned Project.
 * @returns The registered ownership scope and authenticated owner's cookie.
 * @throws {Error} When a fixture write fails.
 */
async function seedFixture(): Promise<Fixture> {
  const ownerId = await seedUser();
  const studioId = randomUUID();
  await sql`INSERT INTO studios (id, created_by_user_id, slug, type, name)
    VALUES (${studioId}, ${ownerId}, ${studioId}, 'personal', 'Media HTTP studio')`;
  owned.studios.push(studioId);
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${ownerId}, 'admin')`;
  const projectId = randomUUID();
  await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug)
    VALUES (${projectId}, ${studioId}, ${ownerId}, 'Media HTTP project', ${`media-${projectId}`})`;
  owned.projects.push(projectId);
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${ownerId}, 'owner', null)`;
  return { ownerId, studioId, projectId, cookie: await loginCookie(ownerId) };
}

/**
 * Register canonical stored metadata without contacting storage or the ingest Worker.
 * @returns The physical asset identity and URL.
 * @throws {Error} When a fixture write fails.
 */
async function seedAsset(fixture: Fixture, kind: "video" | "image" = "video", coverAssetId?: string): Promise<AssetFixture> {
  const id = randomUUID();
  const storageKey = `test-media/${id}.${kind === "video" ? "mp4" : "png"}`;
  const adapter = await getStorageAdapter();
  const fileUrl = adapter.publicUrl(storageKey);
  expect(adapter.keyFromUrl(fileUrl)).toBe(storageKey);
  await sql`INSERT INTO studio_assets
    (id, studio_id, content_hash, storage_key, file_url, size_bytes, mime_type,
      kind, source, produced_by_user_id, width, height, duration_seconds, cover_asset_id)
    VALUES (${id}, ${fixture.studioId}, ${createHash("sha256").update(id).digest("hex")},
      ${storageKey}, ${fileUrl}, 8192, ${kind === "video" ? "video/mp4" : "image/png"},
      ${kind}, 'upload', ${fixture.ownerId}, 1280, 720, ${kind === "video" ? 7.375 : null}, ${coverAssetId ?? null})`;
  owned.assets.push(id);
  return { id, fileUrl, kind };
}

/**
 * Address the three approved Project read endpoints.
 * @returns Their relative request URLs.
 */
function readPaths(projectId: string, assetId: string): string[] {
  const base = `/api/v1/projects/${projectId}`;
  return [`${base}/assets`, `${base}/assets/${assetId}`, `${base}/timeline-limits`];
}

/**
 * Read through the actual app and enforce an expected HTTP status before JSON parsing.
 * @returns The data envelope from a successful request.
 * @throws {Error} When the response is not valid JSON.
 */
async function readData<T>(path: string, cookie: string): Promise<T> {
  const response = await app.request(path, { headers: { Cookie: cookie } });
  expect(response.status, path).toBe(200);
  const envelope = await response.json() as { data: T };
  return envelope.data;
}

describe("Project registered media HTTP reads", () => {
  it.each(["assets", "asset", "timeline-limits"] as const)("requires a session for %s", async (endpoint) => {
    const projectId = randomUUID();
    const suffix = endpoint === "asset" ? `assets/${randomUUID()}` : endpoint;
    const response = await app.request(`/api/v1/projects/${projectId}/${suffix}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 401 } });
  });

  it("lets an invited Viewer without Studio membership read canonical video metadata and public Timeline limits", async () => {
    const fixture = await seedFixture();
    const viewerId = await seedUser();
    await sql`INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${fixture.projectId}, ${viewerId}, 'viewer', ${fixture.ownerId})`;
    const membership = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM studio_members
      WHERE studio_id = ${fixture.studioId} AND user_id = ${viewerId} AND deleted_at IS NULL`;
    expect(membership).toEqual([{ n: 0 }]);
    const cookie = await loginCookie(viewerId);
    const cover = await seedAsset(fixture, "image");
    const video = await seedAsset(fixture, "video", cover.id);
    const image = await seedAsset(fixture, "image");
    const deleted = await seedAsset(fixture);
    await seedAsset(fixture); // Same Studio, but not accepted by this Project.
    const refs = await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: fixture.projectId, assetIds: [video.id, image.id, deleted.id],
      displayNames: { [video.id]: "Product launch.mp4" },
    });
    await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ${deleted.id}`;
    const expected: ProjectRegisteredAsset = {
      assetId: video.id,
      projectReferenceId: refs.find((ref) => ref.assetId === video.id)!.id,
      displayName: "Product launch.mp4", kind: "video", fileUrl: video.fileUrl,
      coverUrl: cover.fileUrl, width: 1280, height: 720, durationSeconds: 7.375,
      mimeType: "video/mp4", sizeBytes: 8192,
    };
    const [listPath, assetPath, limitsPath] = readPaths(fixture.projectId, video.id);
    expect(await readData<ProjectRegisteredAsset>(assetPath!, cookie)).toEqual(expected);
    expect(await readData<ProjectAssetPage>(listPath!, cookie)).toEqual({ items: [expected], nextCursor: null });
    expect(await readData<ProjectAssetPage>(`${listPath}?kind=video`, cookie)).toEqual({ items: [expected], nextCursor: null });
    const config = getTimelineConfig();
    expect(await readData<unknown>(limitsPath!, cookie)).toEqual({
      defaults: { width: config.defaults.width, height: config.defaults.height, fps: config.defaults.fps },
      assets: { pageSize: config.assets.page_size, pageMax: config.assets.page_max },
    });
  });

  it("returns 403 consistently to an authenticated nonmember across all three endpoints", async () => {
    const fixture = await seedFixture();
    const asset = await seedAsset(fixture);
    await projectAssetReferenceService.recordProjectAssetReferences({ projectId: fixture.projectId, assetIds: [asset.id] });
    const outsider = await loginCookie(await seedUser());
    for (const path of readPaths(fixture.projectId, asset.id)) {
      const response = await app.request(path, { headers: { Cookie: outsider } });
      expect(response.status, path).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 403 } });
    }
  });

  it("rechecks revoked Viewer membership instead of trusting the existing session", async () => {
    const fixture = await seedFixture();
    const viewerId = await seedUser();
    await sql`INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${fixture.projectId}, ${viewerId}, 'viewer', ${fixture.ownerId})`;
    const cookie = await loginCookie(viewerId);
    const asset = await seedAsset(fixture);
    await projectAssetReferenceService.recordProjectAssetReferences({ projectId: fixture.projectId, assetIds: [asset.id] });
    const paths = readPaths(fixture.projectId, asset.id);
    for (const path of paths) await readData<unknown>(path, cookie);
    await sql`UPDATE project_members SET deleted_at = now() WHERE project_id = ${fixture.projectId} AND user_id = ${viewerId}`;
    for (const path of paths) {
      const response = await app.request(path, { headers: { Cookie: cookie } });
      expect(response.status, path).toBe(403);
    }
  });

  it.each(["Project", "Studio"] as const)("denies all reads after the owning %s is soft-deleted", async (scope) => {
    const fixture = await seedFixture();
    const asset = await seedAsset(fixture);
    await projectAssetReferenceService.recordProjectAssetReferences({ projectId: fixture.projectId, assetIds: [asset.id] });
    if (scope === "Project") await sql`UPDATE projects SET deleted_at = now() WHERE id = ${fixture.projectId}`;
    else await sql`UPDATE studios SET deleted_at = now() WHERE id = ${fixture.studioId}`;
    for (const path of readPaths(fixture.projectId, asset.id)) {
      const response = await app.request(path, { headers: { Cookie: fixture.cookie } });
      expect(response.status, path).toBe(403);
    }
  });

  it.each(["unassociated", "deleted", "foreign"] as const)("returns 404 for a %s asset to an authorized Project reader", async (state) => {
    const fixture = await seedFixture();
    const asset = await seedAsset(state === "foreign" ? await seedFixture() : fixture);
    if (state === "deleted") {
      await projectAssetReferenceService.recordProjectAssetReferences({ projectId: fixture.projectId, assetIds: [asset.id] });
      await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ${asset.id}`;
    }
    const response = await app.request(readPaths(fixture.projectId, asset.id)[1]!, { headers: { Cookie: fixture.cookie } });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 404 } });
    if (state === "unassociated") {
      const missing = await app.request(readPaths(fixture.projectId, randomUUID())[1]!, { headers: { Cookie: fixture.cookie } });
      expect(missing.status).toBe(404);
    }
  });

  it("preserves microseconds and UUID ties through the HTTP cursor without gaps or duplicates", async () => {
    const fixture = await seedFixture();
    const prefix = randomUUID().slice(0, 24);
    const ordered = [
      { id: `${prefix}000000000001`, at: "2026-10-24 12:00:00.000003+00" },
      { id: `${prefix}000000000002`, at: "2026-10-24 12:00:00.000002+00" },
      { id: `${prefix}000000000004`, at: "2026-10-24 12:00:00.000001+00" },
      { id: `${prefix}000000000003`, at: "2026-10-24 12:00:00.000001+00" },
    ];
    const assetIds: string[] = [];
    for (const entry of ordered) {
      const asset = await seedAsset(fixture);
      assetIds.push(asset.id);
      await projectAssetReferenceService.recordProjectAssetReferences({ projectId: fixture.projectId, assetIds: [asset.id] });
      await sql`UPDATE project_asset_refs SET id = ${entry.id}, created_at = ${entry.at}::text::timestamptz
        WHERE project_id = ${fixture.projectId} AND asset_id = ${asset.id}`;
    }
    const persisted = await sql<{ id: string; at: string }[]>`SELECT id, created_at::text AS at
      FROM project_asset_refs WHERE project_id = ${fixture.projectId} AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`;
    expect(persisted).toEqual(ordered);
    let cursor: string | null = null;
    const seen: string[] = [];
    for (let index = 0; index < ordered.length; index += 1) {
      const query = new URLSearchParams({ kind: "video", limit: "1" });
      if (cursor !== null) query.set("cursor", cursor);
      const page = await readData<ProjectAssetPage>(`/api/v1/projects/${fixture.projectId}/assets?${query}`, fixture.cookie);
      expect(page.items.map((item) => item.assetId)).toEqual([assetIds[index]]);
      expect(page.items.map((item) => item.projectReferenceId)).toEqual([ordered[index]!.id]);
      seen.push(...page.items.map((item) => item.assetId));
      if (index < ordered.length - 1) expect(page.nextCursor).toEqual(expect.any(String));
      else expect(page.nextCursor).toBeNull();
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(assetIds);
    expect(new Set(seen).size).toBe(4);
  });

  it("rejects query schema violations and the API limit above 1000 with 422", async () => {
    const fixture = await seedFixture();
    const queries = [
      "kind=audio", "kind=unknown", "limit=0", "limit=-1", "limit=1.5", "limit=abc", "limit=1001",
      "cursor=", `cursor=${"a".repeat(513)}`,
    ];
    for (const query of queries) {
      const path = `/api/v1/projects/${fixture.projectId}/assets?${query}`;
      const response = await app.request(path, { headers: { Cookie: fixture.cookie } });
      expect(response.status, query).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: 422 } });
    }
  });

  it("returns 400 when a schema-valid cursor string cannot be decoded", async () => {
    const fixture = await seedFixture();
    const path = `/api/v1/projects/${fixture.projectId}/assets?cursor=not-a-cursor`;
    const response = await app.request(path, { headers: { Cookie: fixture.cookie } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 400 } });
  });

  it("rejects malformed Project and asset UUID parameters with 422", async () => {
    const fixture = await seedFixture();
    const paths = [
      ...readPaths("not-a-uuid", randomUUID()),
      `/api/v1/projects/${fixture.projectId}/assets/not-a-uuid`,
    ];
    for (const path of paths) {
      const response = await app.request(path, { headers: { Cookie: fixture.cookie } });
      expect(response.status, path).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: 422 } });
    }
  });

  it("applies configured default and maximum page sizes while accepting the hard API bound", async () => {
    const fixture = await seedFixture();
    const { page_size: pageSize, page_max: pageMax } = getTimelineConfig().assets;
    const assetIds: string[] = [];
    for (let index = 0; index <= pageMax; index += 1) assetIds.push((await seedAsset(fixture)).id);
    await projectAssetReferenceService.recordProjectAssetReferences({ projectId: fixture.projectId, assetIds });
    const path = `/api/v1/projects/${fixture.projectId}/assets`;
    const defaultPage = await readData<ProjectAssetPage>(path, fixture.cookie);
    expect(defaultPage.items).toHaveLength(pageSize);
    expect(defaultPage.nextCursor).toEqual(expect.any(String));
    const maximumPage = await readData<ProjectAssetPage>(`${path}?limit=1000`, fixture.cookie);
    expect(maximumPage.items).toHaveLength(pageMax);
    expect(maximumPage.nextCursor).toEqual(expect.any(String));
    expect(new Set(maximumPage.items.map((item) => item.assetId)).size).toBe(pageMax);
    for (const item of maximumPage.items) expect(assetIds).toContain(item.assetId);
  });
});
