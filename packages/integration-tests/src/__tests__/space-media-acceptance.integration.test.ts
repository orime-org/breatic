// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Real business/Yjs database acceptance boundaries for semantic media (inner#1707). */

import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import * as Y from "yjs";
import {
  createPgClient,
  encodeInitialMetaState,
  getStorageAdapter,
  initCore,
  loadLocales,
  projectAssetReferenceService,
} from "@breatic/core";
import {
  CANVAS_NODES_KEY,
  canvasSpaceDocName,
  documentBodyFragment,
  documentSpaceDocName,
  initializeTimelineDocument,
  projectMetaDocName,
  timelineSpaceDocName,
} from "@breatic/shared";
import type { SpaceType } from "@breatic/shared";
import { fetchDoc, storeDoc } from "@collab/services/persistence.js";
import { handleLifecycleEvent } from "@collab/services/lifecycle-listener.js";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import { duplicate } from "@server/modules/project/project.service.js";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

interface Scope { ownerId: string; studioId: string; projectId: string }
interface Asset { id: string; fileUrl: string }
interface Reference { id: string; asset_id: string; display_name: string | null }
interface CopyFixture {
  scope: Scope; targetId: string; spaceId: string; sourceContent: string;
  targetContent: string; sourceMeta: string; targetMeta: string;
  sourceAsset: Asset; sourceBytes: Uint8Array; metaBytes: Uint8Array;
}
interface Publication {
  projectId: string; reason: string; references: string[];
  content: number[] | null; meta: number[] | null;
}

let sql: ReturnType<typeof createPgClient>;
let yjsSql: ReturnType<typeof createPgClient>;
const owned = { users: [] as string[], studios: [] as string[], projects: [] as string[], assets: [] as string[] };
const names = new Set<string>();
const documents = new Set<Y.Doc>();

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = createPgClient(inject("DATABASE_URL"), { name: "space-media-acceptance-driver", max: 4, prepare: false });
  yjsSql = createPgClient(inject("YJS_DATABASE_URL"), { name: "space-media-acceptance-yjs-driver", max: 4, prepare: false });
});

afterEach(async () => {
  try {
    if (names.size > 0) await yjsSql`UPDATE yjs_documents SET deleted_at = now() WHERE name = ANY(${[...names]}::text[])`;
    if (owned.studios.length > 0) {
      await sql`UPDATE project_asset_refs SET deleted_at = now()
        WHERE project_id IN (SELECT id FROM projects WHERE studio_id = ANY(${owned.studios}::uuid[]))`;
      await sql`UPDATE project_members SET deleted_at = now()
        WHERE project_id IN (SELECT id FROM projects WHERE studio_id = ANY(${owned.studios}::uuid[]))`;
      await sql`UPDATE projects SET deleted_at = now() WHERE studio_id = ANY(${owned.studios}::uuid[])`;
    }
    if (owned.assets.length > 0) await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ANY(${owned.assets}::uuid[])`;
    if (owned.studios.length > 0) {
      await sql`UPDATE studio_members SET deleted_at = now() WHERE studio_id = ANY(${owned.studios}::uuid[])`;
      await sql`UPDATE studios SET deleted_at = now() WHERE id = ANY(${owned.studios}::uuid[])`;
    }
    if (owned.users.length > 0) await sql`UPDATE users SET deleted_at = now() WHERE id = ANY(${owned.users}::uuid[])`;
  } finally {
    for (const document of documents) document.destroy();
    documents.clear();
    names.clear();
    owned.users.length = 0;
    owned.studios.length = 0;
    owned.projects.length = 0;
    owned.assets.length = 0;
  }
});

afterAll(async () => {
  await Promise.all([sql.end({ timeout: 1 }), yjsSql.end({ timeout: 1 })]);
});

/**
 * Track a document so every test releases its Yjs resources.
 * @returns The new, optionally decoded document.
 * @throws {Error} When bytes cannot be decoded.
 */
function doc(bytes?: Uint8Array): Y.Doc {
  const value = new Y.Doc();
  documents.add(value);
  if (bytes !== undefined) Y.applyUpdate(value, bytes);
  return value;
}

/**
 * Register a test-owned document row for soft-delete teardown.
 * @returns The unchanged document name.
 * @throws {never} Never.
 */
function own(name: string): string {
  names.add(name);
  return name;
}

/**
 * Name fixture rows with the existing per-kind shared builders.
 * @returns The canonical content row name.
 * @throws {never} Never.
 */
function contentName(projectId: string, kind: SpaceType, spaceId: string): string {
  switch (kind) {
    case "canvas": return canvasSpaceDocName(projectId, spaceId);
    case "document": return documentSpaceDocName(projectId, spaceId);
    case "timeline": return timelineSpaceDocName(projectId, spaceId);
  }
}

/**
 * Insert one Project and its actual owner membership in an existing Studio.
 * @returns The new Project id.
 * @throws {Error} When fixture SQL fails.
 */
async function seedProject(studioId: string, ownerId: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug)
    VALUES (${id}, ${studioId}, ${ownerId}, 'Space media acceptance', ${`acceptance-${id}`})`;
  owned.projects.push(id);
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${id}, ${ownerId}, 'owner', null)`;
  return id;
}

/**
 * Prepare an isolated base-tier owner, their Studio and one Project.
 * @returns The real authorization and ownership scope.
 * @throws {Error} When fixture SQL fails.
 */
async function seedScope(): Promise<Scope> {
  const ownerId = randomUUID();
  owned.users.push(ownerId);
  await sql`INSERT INTO users (id, email, email_verified, membership_tier)
    VALUES (${ownerId}, ${`space-media-${ownerId}@example.com`}, true, 'base')`;
  const studioId = randomUUID();
  owned.studios.push(studioId);
  await sql`INSERT INTO studios (id, created_by_user_id, slug, type, name)
    VALUES (${studioId}, ${ownerId}, ${studioId}, 'personal', 'Space media acceptance')`;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${ownerId}, 'admin')`;
  return { ownerId, studioId, projectId: await seedProject(studioId, ownerId) };
}

/**
 * Register canonical media facts without requiring external object storage.
 * @returns The ledger id and its canonical URL.
 * @throws {Error} When fixture SQL or adapter initialization fails.
 */
async function seedAsset(scope: Scope): Promise<Asset> {
  const id = randomUUID();
  const key = `space-media-acceptance/${id}.mp4`;
  const fileUrl = (await getStorageAdapter()).publicUrl(key);
  const hash = createHash("sha256").update(id).digest("hex");
  owned.assets.push(id);
  await sql`INSERT INTO studio_assets
    (id, studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind,
     source, produced_by_user_id, width, height, duration_seconds)
    VALUES (${id}, ${scope.studioId}, ${hash}, ${key}, ${fileUrl}, 8192, 'video/mp4',
      'video', 'upload', ${scope.ownerId}, 1920, 1080, 2)`;
  return { id, fileUrl };
}

/**
 * Capture actual semantic media in each Space's native Yjs structure.
 * @returns A test-owned document containing the supplied references.
 * @throws {Error} When the fixture document cannot be built.
 */
function mediaDocument(kind: SpaceType, assets: readonly Asset[]): Y.Doc {
  const value = doc();
  if (kind === "timeline") initializeTimelineDocument(value, { width: 1920, height: 1080, fps: { num: 24, den: 1 } });
  for (const [index, asset] of assets.entries()) {
    if (kind === "timeline") {
      const id = randomUUID();
      value.getMap("sources").set(id, { id, kind: "video", assetId: asset.id,
        timebase: { num: 24, den: 1 }, extentFrames: 48, durationSeconds: "2", durationOrigin: "registered" });
    } else if (kind === "document") {
      const body = documentBodyFragment(value);
      let group = body.get(0);
      if (!(group instanceof Y.XmlElement)) {
        group = new Y.XmlElement("blockGroup");
        body.insert(0, [group]);
      }
      const block = new Y.XmlElement("blockContainer");
      group.insert(group.length, [block]);
      block.setAttribute("id", randomUUID());
      const video = new Y.XmlElement("video");
      block.insert(0, [video]);
      video.setAttribute("url", asset.fileUrl);
    } else {
      const node = new Y.Map<unknown>();
      value.getMap(CANVAS_NODES_KEY).set(`media-${index}`, node);
      node.set("id", `media-${index}`);
      node.set("type", "video");
      const data = new Y.Map<unknown>();
      node.set("data", data);
      data.set("content", asset.fileUrl);
      data.set("name", "Accepted video");
      data.set("attachments", []);
    }
  }
  return value;
}

/**
 * Read actual live associations through a connection outside application pools.
 * @returns Stable persisted reference identities and names.
 * @throws {Error} When inspection SQL fails.
 */
async function references(projectId: string): Promise<Reference[]> {
  return sql<Reference[]>`SELECT id, asset_id, display_name FROM project_asset_refs
    WHERE project_id = ${projectId} AND deleted_at IS NULL ORDER BY asset_id`;
}

/**
 * Turn absent bytes into an explicit fixture error rather than a new seed.
 * @returns The persisted update.
 * @throws {Error} When the expected live row is missing.
 */
function present(bytes: Uint8Array | null): Uint8Array {
  if (bytes === null) throw new Error("Expected persisted Space bytes");
  return bytes;
}

/**
 * Inject a genuine business-database refusal, scoped to one Project or this call.
 * @returns After the action and all trigger cleanup complete.
 * @throws {Error} When setup, the action or teardown fails.
 */
async function withReferenceFailure(projectId: string | undefined, run: () => Promise<void>): Promise<void> {
  const name = `space_media_ref_fault_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const condition = projectId === undefined ? "TRUE" : `NEW.project_id = '${projectId}'::uuid`;
  await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN
    IF ${condition} THEN RAISE EXCEPTION 'injected Space media reference failure'; END IF;
    RETURN NEW; END $$ LANGUAGE plpgsql`);
  try {
    await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON project_asset_refs FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try { await run(); } finally { await sql.unsafe(`DROP TRIGGER IF EXISTS ${name} ON project_asset_refs`); }
  } finally { await sql.unsafe(`DROP FUNCTION IF EXISTS ${name}()`); }
}

/**
 * Inject a Yjs-database refusal after the independent business acceptance.
 * @returns After the action and all trigger cleanup complete.
 * @throws {Error} When setup, the action or teardown fails.
 */
async function withYjsFailure(documentName: string, run: () => Promise<void>): Promise<void> {
  const name = `space_media_yjs_fault_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await yjsSql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN
    IF NEW.name = '${documentName}' THEN RAISE EXCEPTION 'injected Space Yjs failure'; END IF;
    RETURN NEW; END $$ LANGUAGE plpgsql`);
  try {
    await yjsSql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON yjs_documents FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try { await run(); } finally { await yjsSql.unsafe(`DROP TRIGGER IF EXISTS ${name} ON yjs_documents`); }
  } finally { await yjsSql.unsafe(`DROP FUNCTION IF EXISTS ${name}()`); }
}

/**
 * Hold an uncommitted unique-key competitor at the real association insert.
 * @returns After the test has released the gate and its work has settled.
 * @throws {Error} When gate SQL or the test fails.
 */
async function withReferenceGate(projectId: string, assetId: string, run: (release: () => Promise<void>) => Promise<void>): Promise<void> {
  const gate = await sql.reserve();
  let released = false;
  /**
   * Release the competitor without contributing a committed association.
   * @returns Once the unique-key gate is open.
   * @throws {Error} When the rollback fails.
   */
  async function release(): Promise<void> {
    if (released) return;
    await gate`ROLLBACK`;
    released = true;
  }
  try {
    await gate`BEGIN`;
    await gate`INSERT INTO project_asset_refs (id, project_id, asset_id) VALUES (${randomUUID()}, ${projectId}, ${assetId})`;
    await run(release);
  } finally {
    try { await release(); } finally { gate.release(); }
  }
}

/**
 * Prepare persisted source content plus a distinct target in the same Studio.
 * @returns The full copy identities and captured source bytes.
 * @throws {Error} When fixture SQL or seeding fails.
 */
async function copyFixture(): Promise<CopyFixture> {
  const scope = await seedScope();
  const targetId = await seedProject(scope.studioId, scope.ownerId);
  const sourceAsset = await seedAsset(scope);
  const spaceId = randomUUID();
  const sourceContent = own(contentName(scope.projectId, "canvas", spaceId));
  const targetContent = own(contentName(targetId, "canvas", spaceId));
  const sourceMeta = own(projectMetaDocName(scope.projectId));
  const targetMeta = own(projectMetaDocName(targetId));
  const sourceBytes = Y.encodeStateAsUpdate(mediaDocument("canvas", [sourceAsset]));
  const metaBytes = encodeInitialMetaState({ spaceId, kind: "canvas", name: "Canvas", createdBy: scope.ownerId, ts: 1 });
  await yjsRepo.seedInitialState(sourceContent, sourceBytes);
  await yjsRepo.seedInitialState(sourceMeta, metaBytes);
  return { scope, targetId, spaceId, sourceContent, targetContent, sourceMeta, targetMeta, sourceAsset, sourceBytes, metaBytes };
}

/**
 * Observe persisted facts exactly when the existing lifecycle service publishes.
 * @returns One publication snapshot from the two real databases.
 * @throws {Error} When inspection SQL fails.
 */
async function publication(projectId: string, reason: string, fixture: CopyFixture): Promise<Publication> {
  const content = await yjsRepo.fetchDocData(fixture.targetContent);
  const meta = await yjsRepo.fetchDocData(fixture.targetMeta);
  return { projectId, reason, references: (await references(projectId)).map((row) => row.asset_id),
    content: content === null ? null : Array.from(content), meta: meta === null ? null : Array.from(meta) };
}

describe("Space media acceptance through actual load and store services", () => {
  it.each(["canvas", "document", "timeline"] as const)("accepts registered references from actual %s load bytes without rewriting them", async (kind) => {
    const scope = await seedScope();
    const asset = await seedAsset(scope);
    const name = own(contentName(scope.projectId, kind, randomUUID()));
    const bytes = Y.encodeStateAsUpdate(mediaDocument(kind, [asset]));
    await yjsRepo.seedInitialState(name, bytes);
    expect(await references(scope.projectId)).toEqual([]);

    expect(Array.from(present(await fetchDoc({ documentName: name })))).toEqual(Array.from(bytes));
    expect((await references(scope.projectId)).map((row) => row.asset_id)).toEqual([asset.id]);
    expect(Array.from(present(await yjsRepo.fetchDocData(name)))).toEqual(Array.from(bytes));
  });

  it("refuses a load whose valid reference acceptance fails and retries the unchanged bytes", async () => {
    const scope = await seedScope();
    const asset = await seedAsset(scope);
    const name = own(contentName(scope.projectId, "canvas", randomUUID()));
    const bytes = Y.encodeStateAsUpdate(mediaDocument("canvas", [asset]));
    await yjsRepo.seedInitialState(name, bytes);
    await withReferenceFailure(scope.projectId, async () => {
      await expect(fetchDoc({ documentName: name })).rejects.toBeInstanceOf(Error);
    });
    expect(await references(scope.projectId)).toEqual([]);
    expect(Array.from(present(await yjsRepo.fetchDocData(name)))).toEqual(Array.from(bytes));
    expect(Array.from(present(await fetchDoc({ documentName: name })))).toEqual(Array.from(bytes));
    expect((await references(scope.projectId)).map((row) => row.asset_id)).toEqual([asset.id]);
  });

  it("keeps prior Yjs bytes when store acceptance fails and saves the same captured state on retry", async () => {
    const scope = await seedScope();
    const asset = await seedAsset(scope);
    const name = own(contentName(scope.projectId, "canvas", randomUUID()));
    const original = Y.encodeStateAsUpdate(doc());
    const captured = Y.encodeStateAsUpdate(mediaDocument("canvas", [asset]));
    await yjsRepo.seedInitialState(name, original);
    await withReferenceFailure(scope.projectId, async () => {
      await expect(storeDoc({ documentName: name, state: captured })).rejects.toBeInstanceOf(Error);
    });
    expect(await references(scope.projectId)).toEqual([]);
    expect(Array.from(present(await yjsRepo.fetchDocData(name)))).toEqual(Array.from(original));
    await storeDoc({ documentName: name, state: captured });
    expect((await references(scope.projectId)).map((row) => row.asset_id)).toEqual([asset.id]);
    expect(Array.from(present(await yjsRepo.fetchDocData(name)))).toEqual(Array.from(captured));
  });

  it("accepts the captured snapshot while a later live edit waits for its own store", async () => {
    const scope = await seedScope();
    const first = await seedAsset(scope);
    const second = await seedAsset(scope);
    const name = own(contentName(scope.projectId, "canvas", randomUUID()));
    const original = Y.encodeStateAsUpdate(doc());
    await yjsRepo.seedInitialState(name, original);
    const live = mediaDocument("canvas", [first]);
    const captured = Y.encodeStateAsUpdate(live);
    await withReferenceGate(scope.projectId, first.id, async (release) => {
      const pending = Promise.allSettled([storeDoc({ documentName: name, state: captured })]);
      let settled: PromiseSettledResult<void>[] = [];
      try {
        await waitUntilBlockedOn(sql, ["project_asset_refs", "insert"], 1);
        expect(Array.from(present(await yjsRepo.fetchDocData(name)))).toEqual(Array.from(original));
        const node = live.getMap(CANVAS_NODES_KEY).get("media-0");
        if (!(node instanceof Y.Map)) throw new Error("The live fixture node is missing");
        const data = node.get("data");
        if (!(data instanceof Y.Map)) throw new Error("The live fixture data is missing");
        data.set("content", second.fileUrl);
      } finally {
        await release();
        settled = await pending;
      }
      expect(settled).toEqual([{ status: "fulfilled", value: undefined }]);
    });
    expect((await references(scope.projectId)).map((row) => row.asset_id)).toEqual([first.id]);
    expect(Array.from(present(await yjsRepo.fetchDocData(name)))).toEqual(Array.from(captured));
    await storeDoc({ documentName: name, state: Y.encodeStateAsUpdate(live) });
    expect((await references(scope.projectId)).map((row) => row.asset_id)).toEqual([first.id, second.id].sort());
  });

  it("preserves external, unknown and foreign-Studio media while associating only valid local media", async () => {
    const scope = await seedScope();
    const foreign = await seedScope();
    const valid = await seedAsset(scope);
    const other = await seedAsset(foreign);
    const unknown = { id: randomUUID(), fileUrl: (await getStorageAdapter()).publicUrl(`unknown/${randomUUID()}.mp4`) };
    const external = { id: randomUUID(), fileUrl: "https://outside.test.invalid/accepted-shape.mp4" };
    const name = own(contentName(scope.projectId, "canvas", randomUUID()));
    const bytes = Y.encodeStateAsUpdate(mediaDocument("canvas", [valid, other, unknown, external]));
    await yjsRepo.seedInitialState(name, bytes);
    expect(Array.from(present(await fetchDoc({ documentName: name })))).toEqual(Array.from(bytes));
    await storeDoc({ documentName: name, state: bytes });
    expect((await references(scope.projectId)).map((row) => row.asset_id)).toEqual([valid.id]);
    expect(await references(foreign.projectId)).toEqual([]);
    expect(Array.from(present(await yjsRepo.fetchDocData(name)))).toEqual(Array.from(bytes));
  });

  it("retains accepted business references if the later Yjs write fails", async () => {
    const scope = await seedScope();
    const asset = await seedAsset(scope);
    const name = own(contentName(scope.projectId, "canvas", randomUUID()));
    const original = Y.encodeStateAsUpdate(doc());
    const captured = Y.encodeStateAsUpdate(mediaDocument("canvas", [asset]));
    await yjsRepo.seedInitialState(name, original);
    await withYjsFailure(name, async () => {
      await expect(storeDoc({ documentName: name, state: captured })).rejects.toBeInstanceOf(Error);
    });
    const retained = await references(scope.projectId);
    expect(retained.map((row) => row.asset_id)).toEqual([asset.id]);
    expect(Array.from(present(await yjsRepo.fetchDocData(name)))).toEqual(Array.from(original));
    await storeDoc({ documentName: name, state: captured });
    expect(await references(scope.projectId)).toEqual(retained);
    expect(Array.from(present(await yjsRepo.fetchDocData(name)))).toEqual(Array.from(captured));
  });
});

describe("Project copy media acceptance through actual services", () => {
  it("accepts the actual target winner before publishing the copied meta", async () => {
    const fixture = await copyFixture();
    const winningAsset = await seedAsset(fixture.scope);
    const winningBytes = Y.encodeStateAsUpdate(mediaDocument("canvas", [winningAsset]));
    await yjsRepo.seedInitialState(fixture.targetContent, winningBytes);
    const published: Publication[] = [];
    await handleLifecycleEvent({ type: "project:duplicated", sourceId: fixture.scope.projectId, newId: fixture.targetId, ts: 1 }, async (projectId, reason) => {
      published.push(await publication(projectId, reason, fixture));
    });
    expect(published).toEqual([{ projectId: fixture.targetId, reason: "content-updated", references: [winningAsset.id], content: Array.from(winningBytes), meta: Array.from(fixture.metaBytes) }]);
    expect((await references(fixture.targetId)).map((row) => row.asset_id)).toEqual([winningAsset.id]);
    expect(Array.from(present(await yjsRepo.fetchDocData(fixture.sourceContent)))).toEqual(Array.from(fixture.sourceBytes));
  });

  it("rolls back both copied Yjs rows and suppresses publication when association acceptance fails", async () => {
    const fixture = await copyFixture();
    const published: Publication[] = [];
    const event = { type: "project:duplicated" as const, sourceId: fixture.scope.projectId, newId: fixture.targetId, ts: 1 };
    await withReferenceFailure(fixture.targetId, async () => {
      await expect(handleLifecycleEvent(event, async (projectId, reason) => {
        published.push(await publication(projectId, reason, fixture));
      })).rejects.toBeInstanceOf(Error);
    });
    expect(published).toEqual([]);
    expect(await yjsRepo.fetchDocData(fixture.targetContent)).toBeNull();
    expect(await yjsRepo.fetchDocData(fixture.targetMeta)).toBeNull();
    expect(await references(fixture.targetId)).toEqual([]);
    await handleLifecycleEvent(event, async (projectId, reason) => {
      published.push(await publication(projectId, reason, fixture));
    });
    expect(published).toEqual([{ projectId: fixture.targetId, reason: "content-updated", references: [fixture.sourceAsset.id], content: Array.from(fixture.sourceBytes), meta: Array.from(fixture.metaBytes) }]);
  });

  it("keeps the adopted target bytes when the source changes during accepted-reference contention", async () => {
    const fixture = await copyFixture();
    const winner = await seedAsset(fixture.scope);
    const later = await seedAsset(fixture.scope);
    const winnerBytes = Y.encodeStateAsUpdate(mediaDocument("canvas", [winner]));
    const laterBytes = Y.encodeStateAsUpdate(mediaDocument("canvas", [later]));
    await yjsRepo.seedInitialState(fixture.targetContent, winnerBytes);
    const published: Publication[] = [];
    await withReferenceGate(fixture.targetId, winner.id, async (release) => {
      const pending = Promise.allSettled([handleLifecycleEvent({ type: "project:duplicated", sourceId: fixture.scope.projectId, newId: fixture.targetId, ts: 1 }, async (projectId, reason) => {
        published.push(await publication(projectId, reason, fixture));
      })]);
      let settled: PromiseSettledResult<void>[] = [];
      try {
        await waitUntilBlockedOn(sql, ["project_asset_refs", "insert"], 1);
        expect(await yjsRepo.fetchDocData(fixture.targetMeta)).toBeNull();
        expect(published).toEqual([]);
        await yjsRepo.upsertDocData(fixture.sourceContent, laterBytes);
      } finally {
        await release();
        settled = await pending;
      }
      expect(settled).toEqual([{ status: "fulfilled", value: undefined }]);
    });
    expect(published).toEqual([{ projectId: fixture.targetId, reason: "content-updated", references: [winner.id], content: Array.from(winnerBytes), meta: Array.from(fixture.metaBytes) }]);
    expect((await references(fixture.targetId)).map((row) => row.asset_id)).toEqual([winner.id]);
    expect(Array.from(present(await yjsRepo.fetchDocData(fixture.sourceContent)))).toEqual(Array.from(laterBytes));
  });

  it("copies known references in the real server Project transaction and rolls back a refused copy", async () => {
    const scope = await seedScope();
    const asset = await seedAsset(scope);
    await projectAssetReferenceService.recordProjectAssetReferences({ projectId: scope.projectId, assetIds: [asset.id], displayNames: { [asset.id]: "Known video.mp4" } });
    const source = await references(scope.projectId);
    const copy = await duplicate(scope.projectId, scope.ownerId);
    owned.projects.push(copy.id);
    expect(copy.studioId).toBe(scope.studioId);
    const copied = await references(copy.id);
    expect(copied.map((row) => ({ assetId: row.asset_id, name: row.display_name }))).toEqual([{ assetId: asset.id, name: "Known video.mp4" }]);
    expect(copied.map((row) => row.id)).not.toEqual(source.map((row) => row.id));
    expect(await references(scope.projectId)).toEqual(source);
    const before = await sql<{ id: string }[]>`SELECT id FROM projects WHERE studio_id = ${scope.studioId} AND deleted_at IS NULL ORDER BY id`;
    await withReferenceFailure(undefined, async () => {
      await expect(duplicate(scope.projectId, scope.ownerId)).rejects.toBeInstanceOf(Error);
    });
    expect(await sql<{ id: string }[]>`SELECT id FROM projects WHERE studio_id = ${scope.studioId} AND deleted_at IS NULL ORDER BY id`).toEqual(before);
    expect(await references(copy.id)).toEqual(copied);
    expect(await references(scope.projectId)).toEqual(source);
  });
});
