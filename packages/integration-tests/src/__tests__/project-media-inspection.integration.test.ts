// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createHash, randomUUID } from "node:crypto";
import { sql as statement } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import * as Y from "yjs";
import {
  createPgClient,
  db,
  getStorageAdapter,
  initCore,
  loadLocales,
  NotFoundError,
  projectAssetReferenceService,
  schema,
} from "@breatic/core";
import { CANVAS_NODES_KEY, canvasSpaceDocName } from "@breatic/shared";
import { acceptSpaceMediaReferences } from "@collab/services/space-media-acceptance.js";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";
import { issueUploadTicket } from "@server/modules/asset/upload-ticket.service.js";

interface Fixture { ownerId: string; studioId: string; projectId: string }
interface Asset { id: string; fileUrl: string; storageKey: string; contentHash: string }
interface ReferenceRow {
  id: string;
  asset_id: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

let sql: ReturnType<typeof createPgClient>;
const owned = { users: [] as string[], studios: [] as string[], projects: [] as string[], assets: [] as string[] };

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = createPgClient(inject("DATABASE_URL"), {
    name: "timeline-project-media-inspection-test", max: 4, prepare: false,
  });
});

afterEach(async () => {
  try {
    if (owned.projects.length > 0) {
      await sql`UPDATE project_asset_refs SET deleted_at = now() WHERE project_id = ANY(${owned.projects}::uuid[])`;
      await sql`UPDATE project_members SET deleted_at = now() WHERE project_id = ANY(${owned.projects}::uuid[])`;
      await sql`UPDATE projects SET deleted_at = now() WHERE id = ANY(${owned.projects}::uuid[])`;
    }
    if (owned.assets.length > 0) await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ANY(${owned.assets}::uuid[])`;
    if (owned.studios.length > 0) await sql`UPDATE studios SET deleted_at = now() WHERE id = ANY(${owned.studios}::uuid[])`;
    if (owned.users.length > 0) await sql`UPDATE users SET deleted_at = now() WHERE id = ANY(${owned.users}::uuid[])`;
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
 * Seed an isolated live owning scope using the existing media fixture shape.
 * @returns The ids used to verify canonical Project ownership.
 * @throws {Error} When a fixture database write fails.
 */
async function fixture(): Promise<Fixture> {
  const ownerId = randomUUID();
  await sql`INSERT INTO users (id, email, email_verified)
    VALUES (${ownerId}, ${`timeline-inspect-${ownerId}@example.com`}, true)`;
  owned.users.push(ownerId);
  const studioId = randomUUID();
  await sql`INSERT INTO studios (id, created_by_user_id, slug, type, name)
    VALUES (${studioId}, ${ownerId}, ${studioId}, 'personal', 'Timeline inspection test')`;
  owned.studios.push(studioId);
  const projectId = randomUUID();
  await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug)
    VALUES (${projectId}, ${studioId}, ${ownerId}, 'Timeline inspection test', ${`inspect-${projectId}`})`;
  owned.projects.push(projectId);
  return { ownerId, studioId, projectId };
}

/**
 * Register physical ledger facts without reading or writing stored bytes.
 * @param scope - The actual owning Studio and producer.
 * @returns The canonical identity and storage address.
 * @throws {Error} When fixture creation or storage configuration fails.
 */
async function asset(scope: Fixture): Promise<Asset> {
  const id = randomUUID();
  const storageKey = `inspection-media/${id}.mp4`;
  const adapter = await getStorageAdapter();
  const fileUrl = adapter.publicUrl(storageKey);
  expect(adapter.keyFromUrl(fileUrl)).toBe(storageKey);
  const hash = createHash("sha256").update(id).digest("hex");
  await sql`INSERT INTO studio_assets
    (id, studio_id, content_hash, storage_key, file_url, size_bytes, mime_type,
     kind, source, produced_by_user_id, width, height, duration_seconds)
    VALUES (${id}, ${scope.studioId}, ${hash}, ${storageKey}, ${fileUrl}, 8192,
      'video/mp4', 'video', 'upload', ${scope.ownerId}, 1280, 720, 2.5)`;
  owned.assets.push(id);
  return { id, storageKey, fileUrl, contentHash: hash };
}

/**
 * Read every association row, including retained soft-deleted identities.
 * @param projectId - The fixture Project.
 * @returns PostgreSQL-precision association facts.
 * @throws {Error} When the database read fails.
 */
async function references(projectId: string): Promise<ReferenceRow[]> {
  return sql<ReferenceRow[]>`SELECT id, asset_id, display_name,
      created_at::text AS created_at, updated_at::text AS updated_at,
      deleted_at::text AS deleted_at
    FROM project_asset_refs WHERE project_id = ${projectId} ORDER BY asset_id, id`;
}

/**
 * Capture complete persisted ledger rows for read-only integrity assertions.
 * @param assetIds - The exact rows whose metadata must remain unchanged.
 * @returns Stable JSON values produced from the actual stored records.
 * @throws {Error} When the database read fails.
 */
async function ledgerRows(assetIds: string[]): Promise<{ row: unknown }[]> {
  return sql<{ row: unknown }[]>`SELECT to_jsonb(studio_assets) AS row FROM studio_assets
    WHERE id = ANY(${assetIds}::uuid[]) ORDER BY id`;
}

/**
 * Fail one association insert while allowing preceding rows to be attempted.
 * @param projectId - The Project whose acceptance is under test.
 * @param assetId - The particular insert refused by PostgreSQL.
 * @param run - The real operation whose transaction must roll back.
 * @throws {Error} When setup, the operation, or cleanup fails.
 */
async function withInsertFailure(projectId: string, assetId: string, run: () => Promise<void>): Promise<void> {
  const name = `timeline_inspection_failure_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$
    BEGIN
      IF NEW.project_id = '${projectId}'::uuid AND NEW.asset_id = '${assetId}'::uuid THEN
        RAISE EXCEPTION 'injected detailed association failure';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  try {
    await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON project_asset_refs
      FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      await run();
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${name} ON project_asset_refs`);
    }
  } finally {
    await sql.unsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}

/**
 * Read the database refusal through the driver's enclosing query error.
 * @param error - The rejected service result.
 * @returns Messages at each actual error boundary.
 * @throws {never} Never.
 */
function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
}

describe("Project media inspection", () => {
  it("resolves unassociated canonical media within a PostgreSQL read-only transaction", async () => {
    const scope = await fixture();
    const media = await asset(scope);
    const before = await ledgerRows([media.id]);
    const input = Object.freeze({
      projectId: scope.projectId,
      assetIds: Object.freeze([media.id, media.id]),
      urls: Object.freeze([media.fileUrl]),
    });
    const result = await db.transaction(async (tx) => {
      await tx.execute(statement`SET TRANSACTION READ ONLY`);
      return projectAssetReferenceService.inspectRegisteredProjectMedia(input, tx);
    });
    expect(Object.keys(result).sort()).toEqual(["references", "resolution"]);
    expect(result.resolution.resolved.map((entry) => ({ kind: entry.kind, reference: entry.reference, assetId: entry.asset.id }))).toEqual([
      { kind: "assetId", reference: media.id, assetId: media.id },
      { kind: "url", reference: media.fileUrl, assetId: media.id },
    ]);
    expect(result.resolution.unavailable).toEqual([]);
    expect(result.references).toEqual([]);
    expect(await references(scope.projectId)).toEqual([]);
    expect(await ledgerRows([media.id])).toEqual(before);
    expect(input).toEqual({ projectId: scope.projectId, assetIds: [media.id, media.id], urls: [media.fileUrl] });
  });

  it("returns only the requested media's existing live references", async () => {
    const scope = await fixture();
    const existing = await asset(scope);
    const unrelated = await asset(scope);
    const missing = await asset(scope);
    const accepted = await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: scope.projectId, assetIds: [existing.id, unrelated.id],
      displayNames: { [existing.id]: "Original video.mp4" },
    });
    const before = await references(scope.projectId);
    const result = await projectAssetReferenceService.inspectRegisteredProjectMedia({
      projectId: scope.projectId, assetIds: [missing.id, existing.id], urls: [existing.fileUrl],
    });
    expect(result.references).toEqual(accepted.filter((entry) => entry.assetId === existing.id));
    expect([...new Set(result.resolution.resolved.map((entry) => entry.asset.id))].sort()).toEqual([missing.id, existing.id].sort());
    expect(result.resolution.unavailable).toEqual([]);
    expect(await references(scope.projectId)).toEqual(before);
  });

  it("keeps soft-deleted references retained during inspection", async () => {
    const scope = await fixture();
    const media = await asset(scope);
    await projectAssetReferenceService.recordProjectAssetReferences({ projectId: scope.projectId, assetIds: [media.id] });
    await sql`UPDATE project_asset_refs SET deleted_at = now() WHERE project_id = ${scope.projectId}`;
    const before = await references(scope.projectId);
    const result = await projectAssetReferenceService.inspectRegisteredProjectMedia({ projectId: scope.projectId, assetIds: [media.id] });
    expect(result.resolution.resolved.map((entry) => entry.asset.id)).toEqual([media.id]);
    expect(result.references).toEqual([]);
    expect(await references(scope.projectId)).toEqual(before);
  });

  it("classifies external, unknown, foreign, and deleted media without modifying ledger or relationships", async () => {
    const scope = await fixture();
    const foreign = await fixture();
    const valid = await asset(scope);
    const deleted = await asset(scope);
    const foreignMedia = await asset(foreign);
    await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ${deleted.id}`;
    const unknownId = randomUUID();
    const adapter = await getStorageAdapter();
    const unknownUrl = adapter.publicUrl(`inspection-unknown/${unknownId}.mp4`);
    const externalUrl = "https://outside.test.invalid/inspection-video.mp4";
    const before = await ledgerRows([valid.id, deleted.id, foreignMedia.id]);
    const result = await projectAssetReferenceService.inspectRegisteredProjectMedia({
      projectId: scope.projectId,
      assetIds: [foreignMedia.id, deleted.id, unknownId, valid.id],
      urls: [externalUrl, foreignMedia.fileUrl, deleted.fileUrl, unknownUrl, valid.fileUrl],
    });
    expect(result.resolution.resolved.map((entry) => ({ kind: entry.kind, reference: entry.reference, assetId: entry.asset.id }))).toEqual([
      { kind: "assetId", reference: valid.id, assetId: valid.id },
      { kind: "url", reference: valid.fileUrl, assetId: valid.id },
    ]);
    const expected = [
      { kind: "assetId", reference: foreignMedia.id, reason: "foreign_studio" },
      { kind: "assetId", reference: deleted.id, reason: "unregistered" },
      { kind: "assetId", reference: unknownId, reason: "unregistered" },
      { kind: "url", reference: externalUrl, reason: "external" },
      { kind: "url", reference: foreignMedia.fileUrl, reason: "foreign_studio" },
      { kind: "url", reference: deleted.fileUrl, reason: "unregistered" },
      { kind: "url", reference: unknownUrl, reason: "unregistered" },
    ].sort((left, right) => `${left.kind}:${left.reference}` < `${right.kind}:${right.reference}` ? -1 : 1);
    expect(result.resolution.unavailable).toEqual(expected);
    expect(result.references).toEqual([]);
    expect(await references(scope.projectId)).toEqual([]);
    expect(await ledgerRows([valid.id, deleted.id, foreignMedia.id])).toEqual(before);
  });

  it("reads an association that exists only in the supplied transaction", async () => {
    const scope = await fixture();
    const media = await asset(scope);
    const referenceId = randomUUID();
    const rollback = new Error("rollback inspection visibility");
    await expect(db.transaction(async (tx) => {
      await tx.insert(schema.projectAssetRefs).values({
        id: referenceId, projectId: scope.projectId, assetId: media.id, displayName: "Uncommitted video.mp4",
      });
      const result = await projectAssetReferenceService.inspectRegisteredProjectMedia({ projectId: scope.projectId, assetIds: [media.id] }, tx);
      expect(result.references.map((entry) => ({ id: entry.id, name: entry.displayName }))).toEqual([
        { id: referenceId, name: "Uncommitted video.mp4" },
      ]);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await references(scope.projectId)).toEqual([]);
  });

  it.each(["missing", "project_deleted", "studio_deleted"] as const)("preserves unavailable scope behavior for %s", async (condition) => {
    const scope = await fixture();
    const media = await asset(scope);
    if (condition === "project_deleted") await sql`UPDATE projects SET deleted_at = now() WHERE id = ${scope.projectId}`;
    if (condition === "studio_deleted") await sql`UPDATE studios SET deleted_at = now() WHERE id = ${scope.studioId}`;
    const projectId = condition === "missing" ? randomUUID() : scope.projectId;
    const before = await ledgerRows([media.id]);
    const inspection = projectAssetReferenceService.inspectRegisteredProjectMedia({ projectId, assetIds: [media.id] });
    await expect(inspection).rejects.toBeInstanceOf(NotFoundError);
    await expect(inspection).rejects.toBeInstanceOf(projectAssetReferenceService.ProjectMediaScopeUnavailableError);
    expect(await references(scope.projectId)).toEqual([]);
    expect(await ledgerRows([media.id])).toEqual(before);
  });

  it("inspects an empty reference set without adding relationships", async () => {
    const scope = await fixture();
    const result = await projectAssetReferenceService.inspectRegisteredProjectMedia({ projectId: scope.projectId });
    expect(result).toEqual({ resolution: { resolved: [], unavailable: [] }, references: [] });
    expect(await references(scope.projectId)).toEqual([]);
  });
});

describe("Detailed canonical Project media acceptance", () => {
  it("returns an empty detailed result for an empty batch", async () => {
    const scope = await fixture();
    expect(await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({ projectId: scope.projectId })).toEqual({
      resolution: { resolved: [], unavailable: [] }, references: [], insertedAssetIds: [],
    });
    expect(await references(scope.projectId)).toEqual([]);
  });

  it.each(["missing", "project_deleted", "studio_deleted"] as const)("rejects detailed acceptance for %s", async (condition) => {
    const scope = await fixture();
    const media = await asset(scope);
    if (condition === "project_deleted") await sql`UPDATE projects SET deleted_at = now() WHERE id = ${scope.projectId}`;
    if (condition === "studio_deleted") await sql`UPDATE studios SET deleted_at = now() WHERE id = ${scope.studioId}`;
    const projectId = condition === "missing" ? randomUUID() : scope.projectId;
    const acceptance = projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({ projectId, assetIds: [media.id] });
    await expect(acceptance).rejects.toBeInstanceOf(NotFoundError);
    await expect(acceptance).rejects.toBeInstanceOf(projectAssetReferenceService.ProjectMediaScopeUnavailableError);
    expect(await references(scope.projectId)).toEqual([]);
  });

  it("retains an ordinary not-found error when a requested asset is missing from a live Project", async () => {
    const scope = await fixture();
    const media = await asset(scope);
    const before = await ledgerRows([media.id]);
    const acceptance = projectAssetReferenceService.recordProjectAssetReferences({
      projectId: scope.projectId, assetIds: [media.id, randomUUID()],
    });
    await expect(acceptance).rejects.toBeInstanceOf(NotFoundError);
    await expect(acceptance).rejects.not.toBeInstanceOf(projectAssetReferenceService.ProjectMediaScopeUnavailableError);
    expect(await references(scope.projectId)).toEqual([]);
    expect(await ledgerRows([media.id])).toEqual(before);
  });

  it("reports actual inserted identities once across asset ids and URLs", async () => {
    const scope = await fixture();
    const first = await asset(scope);
    const second = await asset(scope);
    const input = {
      projectId: scope.projectId, assetIds: [second.id, first.id, first.id],
      urls: [second.fileUrl, first.fileUrl, first.fileUrl],
      displayNames: { [first.id]: "First accepted.mp4", [second.id]: "Second accepted.mp4" },
    };
    const result = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed(input);
    expect(Object.keys(result).sort()).toEqual(["insertedAssetIds", "references", "resolution"]);
    expect(result.insertedAssetIds).toEqual([first.id, second.id].sort());
    expect(result.references.map((entry) => entry.assetId)).toEqual([first.id, second.id].sort());
    expect(result.references.map((entry) => ({ assetId: entry.assetId, name: entry.displayName }))).toEqual([
      { assetId: first.id, name: "First accepted.mp4" },
      { assetId: second.id, name: "Second accepted.mp4" },
    ].sort((left, right) => left.assetId < right.assetId ? -1 : 1));
    expect(result.resolution.resolved.map((entry) => ({ kind: entry.kind, reference: entry.reference }))).toEqual([
      ...[first.id, second.id].sort().map((reference) => ({ kind: "assetId", reference })),
      ...[first.fileUrl, second.fileUrl].sort().map((reference) => ({ kind: "url", reference })),
    ]);
    expect(result.resolution.unavailable).toEqual([]);
    const before = await references(scope.projectId);
    const repeated = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
      ...input, assetIds: [...input.assetIds].reverse(), urls: [...input.urls].reverse(),
      displayNames: { [first.id]: "Later name.mp4", [second.id]: "Later second.mp4" },
    });
    expect(repeated.insertedAssetIds).toEqual([]);
    expect(repeated.references).toEqual(result.references);
    expect(repeated.resolution).toEqual(result.resolution);
    expect(await references(scope.projectId)).toEqual(before);
  });

  it.each(["missing", "empty"] as const)("fills an initially %s name once without changing reference identity or timestamps", async (initialName) => {
    const scope = await fixture();
    const media = await asset(scope);
    const first = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
      projectId: scope.projectId, assetIds: [media.id],
      ...(initialName === "empty" ? { displayNames: { [media.id]: "" } } : {}),
    });
    const before = await references(scope.projectId);
    expect(first.insertedAssetIds).toEqual([media.id]);
    expect(first.references.map((entry) => entry.displayName)).toEqual([null]);
    for (const displayNames of [undefined, { [media.id]: "" }]) {
      const unnamed = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
        projectId: scope.projectId, assetIds: [media.id],
        ...(displayNames === undefined ? {} : { displayNames }),
      });
      expect(unnamed.insertedAssetIds).toEqual([]);
      expect(unnamed.references).toEqual(first.references);
      expect(await references(scope.projectId)).toEqual(before);
    }
    const named = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
      projectId: scope.projectId, urls: [media.fileUrl], displayNames: { [media.id]: "First verified.mp4" },
    });
    expect(named.insertedAssetIds).toEqual([]);
    expect(named.references).toEqual(first.references.map((entry) => ({ ...entry, displayName: "First verified.mp4" })));
    const after = before.map((entry) => ({ ...entry, display_name: "First verified.mp4" }));
    expect(await references(scope.projectId)).toEqual(after);
    for (const displayNames of [undefined, { [media.id]: "" }, { [media.id]: "Later label.mp4" }]) {
      const repeated = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
        projectId: scope.projectId, assetIds: [media.id],
        ...(displayNames === undefined ? {} : { displayNames }),
      });
      expect(repeated.insertedAssetIds).toEqual([]);
      expect(repeated.references).toEqual(named.references);
      expect(await references(scope.projectId)).toEqual(after);
    }
  });

  it("exposes the first upload filename after an unnamed Canvas acceptance and hash dedup", async () => {
    const scope = await fixture();
    const media = await asset(scope);
    await sql`INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${scope.projectId}, ${scope.ownerId}, 'owner', null)`;
    const canvas = new Y.Doc();
    try {
      canvas.getMap(CANVAS_NODES_KEY).set(randomUUID(), { type: "video", data: { content: media.fileUrl } });
      await acceptSpaceMediaReferences(canvasSpaceDocName(scope.projectId, randomUUID()), Y.encodeStateAsUpdate(canvas));
    } finally {
      canvas.destroy();
    }
    const before = await references(scope.projectId);
    expect(before.map((entry) => ({ assetId: entry.asset_id, name: entry.display_name }))).toEqual([
      { assetId: media.id, name: null },
    ]);
    const ledgerBefore = await ledgerRows([media.id]);
    for (const filename of ["First upload.mp4", "Later upload.mp4"]) {
      const outcome = await issueUploadTicket(
        { userId: scope.ownerId, studioId: scope.studioId, projectId: scope.projectId },
        { filename, content_type: "video/mp4", size: 8192, client_hash: media.contentHash, space_id: randomUUID() },
        async () => true,
      );
      expect(outcome).toMatchObject({ kind: "alreadyExists", assetId: media.id, fileUrl: media.fileUrl });
      const persisted = await references(scope.projectId);
      const resolved = await projectAssetReferenceService.resolveProjectAsset({
        projectId: scope.projectId, userId: scope.ownerId, assetId: media.id,
      });
      const page = await projectAssetReferenceService.listProjectVideos({ projectId: scope.projectId, userId: scope.ownerId });
      expect(persisted).toEqual(before.map((entry) => ({ ...entry, display_name: "First upload.mp4" })));
      expect(resolved).toMatchObject({ assetId: media.id, projectReferenceId: before[0]!.id, displayName: "First upload.mp4" });
      expect(page).toEqual({ items: [resolved], nextCursor: null });
    }
    const repeated = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({ projectId: scope.projectId, assetIds: [media.id] });
    expect(repeated.insertedAssetIds).toEqual([]);
    expect(repeated.references.map((entry) => entry.displayName)).toEqual(["First upload.mp4"]);
    expect(await ledgerRows([media.id])).toEqual(ledgerBefore);
  });

  it("counts only new inserts in a batch that fills one name and preserves another", async () => {
    const scope = await fixture();
    const unnamed = await asset(scope);
    const named = await asset(scope);
    const incoming = await asset(scope);
    const previous = await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: scope.projectId, assetIds: [unnamed.id, named.id], displayNames: { [named.id]: "Original.mp4" },
    });
    const before = await references(scope.projectId);
    const input = {
      projectId: scope.projectId, assetIds: [incoming.id, unnamed.id, named.id, unnamed.id],
      urls: [unnamed.fileUrl, incoming.fileUrl],
      displayNames: { [unnamed.id]: "First verified.mp4", [named.id]: "Ignored.mp4", [incoming.id]: "New.mp4" },
    };
    const result = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed(input);
    expect(result.insertedAssetIds).toEqual([incoming.id]);
    expect(result.references.map((entry) => entry.assetId)).toEqual([unnamed.id, named.id, incoming.id].sort());
    expect(result.references.filter((entry) => entry.assetId !== incoming.id)).toEqual(previous.map((entry) => (
      entry.assetId === unnamed.id ? { ...entry, displayName: "First verified.mp4" } : entry
    )));
    const after = await references(scope.projectId);
    expect(after.filter((entry) => entry.asset_id !== incoming.id)).toEqual(before.map((entry) => (
      entry.asset_id === unnamed.id ? { ...entry, display_name: "First verified.mp4" } : entry
    )));
    expect(after.filter((entry) => entry.asset_id === incoming.id).map((entry) => entry.display_name)).toEqual(["New.mp4"]);
    const repeated = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
      ...input, displayNames: { [unnamed.id]: "Later.mp4", [named.id]: "Later.mp4", [incoming.id]: "Later.mp4" },
    });
    expect(repeated.insertedAssetIds).toEqual([]);
    expect(repeated.references).toEqual(result.references);
    expect(await references(scope.projectId)).toEqual(after);
  });

  it("returns existing and newly inserted batch references with accurate inserted ids", async () => {
    const scope = await fixture();
    const existing = await asset(scope);
    const incoming = await asset(scope);
    const previous = await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: scope.projectId, assetIds: [existing.id], displayNames: { [existing.id]: "Existing.mp4" },
    });
    const result = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
      projectId: scope.projectId, assetIds: [incoming.id, existing.id],
    });
    expect(result.insertedAssetIds).toEqual([incoming.id]);
    expect(result.references.map((entry) => entry.assetId)).toEqual([existing.id, incoming.id].sort());
    expect(result.references.filter((entry) => entry.assetId === existing.id)).toEqual(previous);
  });

  it("reports unavailable references while accepting valid canonical media", async () => {
    const scope = await fixture();
    const foreign = await fixture();
    const valid = await asset(scope);
    const foreignMedia = await asset(foreign);
    const unknownId = randomUUID();
    const result = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
      projectId: scope.projectId, assetIds: [foreignMedia.id, unknownId, valid.id],
      urls: ["https://outside.test.invalid/inspection-unavailable.mp4"],
    });
    expect(result.insertedAssetIds).toEqual([valid.id]);
    expect(result.references.map((entry) => entry.assetId)).toEqual([valid.id]);
    expect(result.resolution.resolved.map((entry) => entry.asset.id)).toEqual([valid.id]);
    expect(result.resolution.unavailable).toEqual([
      ...[
        { kind: "assetId", reference: foreignMedia.id, reason: "foreign_studio" },
        { kind: "assetId", reference: unknownId, reason: "unregistered" },
      ].sort((left, right) => left.reference < right.reference ? -1 : 1),
      { kind: "url", reference: "https://outside.test.invalid/inspection-unavailable.mp4", reason: "external" },
    ]);
  });

  it("reports an unavailable-only batch with no accepted or inserted identities", async () => {
    const scope = await fixture();
    const deleted = await asset(scope);
    await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ${deleted.id}`;
    const result = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
      projectId: scope.projectId, assetIds: [deleted.id],
      urls: ["https://outside.test.invalid/unavailable-only.mp4"],
    });
    expect(result).toEqual({
      resolution: {
        resolved: [],
        unavailable: [
          { kind: "assetId", reference: deleted.id, reason: "unregistered" },
          { kind: "url", reference: "https://outside.test.invalid/unavailable-only.mp4", reason: "external" },
        ],
      },
      references: [], insertedAssetIds: [],
    });
    expect(await references(scope.projectId)).toEqual([]);
  });

  it("identifies one actual insertion across two PostgreSQL-blocked competing accepts", async () => {
    const scope = await fixture();
    const media = await asset(scope);
    const gate = createPgClient(inject("DATABASE_URL"), {
      name: "timeline-detailed-reference-unique-gate", max: 1, prepare: false,
    });
    try {
      await gate`BEGIN`;
      await gate`INSERT INTO project_asset_refs (id, project_id, asset_id)
        VALUES (${randomUUID()}, ${scope.projectId}, ${media.id})`;
      const input = { projectId: scope.projectId, assetIds: [media.id], urls: [media.fileUrl] };
      const accepts = Promise.allSettled([
        projectAssetReferenceService.referenceRegisteredProjectMediaDetailed(input),
        projectAssetReferenceService.referenceRegisteredProjectMediaDetailed(input),
      ]);
      let probeError: unknown;
      try {
        await waitUntilBlockedOn(sql, ["insert", "project_asset_refs"], 2);
      } catch (error) {
        probeError = error;
      } finally {
        await gate`ROLLBACK`;
      }
      const settled = await accepts;
      if (probeError !== undefined) throw probeError;
      expect(settled.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
      const results = settled.map((entry) => {
        if (entry.status !== "fulfilled") throw entry.reason;
        return entry.value;
      });
      expect(results.map((entry) => entry.insertedAssetIds.length).sort()).toEqual([0, 1]);
      expect(results.flatMap((entry) => entry.insertedAssetIds)).toEqual([media.id]);
      const persisted = await references(scope.projectId);
      expect(persisted).toHaveLength(1);
      expect(results.map((entry) => entry.references.map((reference) => reference.id))).toEqual([
        [persisted[0]!.id], [persisted[0]!.id],
      ]);
    } finally {
      await gate.end({ timeout: 1 });
    }
  });

  it("keeps one first name across two PostgreSQL-blocked competing name fills", async () => {
    const scope = await fixture();
    const media = await asset(scope);
    const initial = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({ projectId: scope.projectId, assetIds: [media.id] });
    const before = await references(scope.projectId);
    expect(before.map((entry) => entry.display_name)).toEqual([null]);
    const gate = createPgClient(inject("DATABASE_URL"), {
      name: "timeline-detailed-reference-name-gate", max: 1, prepare: false,
    });
    const pending: Promise<projectAssetReferenceService.RegisteredProjectMediaAcceptance>[] = [];
    try {
      await gate`BEGIN`;
      await gate`SELECT id FROM project_asset_refs WHERE project_id = ${scope.projectId} AND asset_id = ${media.id} FOR UPDATE`;
      const names = ["First contender.mp4", "Second contender.mp4"];
      pending.push(...names.map((name) => projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
        projectId: scope.projectId, assetIds: [media.id], displayNames: { [media.id]: name },
      })));
      const accepts = Promise.allSettled(pending);
      let probeError: unknown;
      try {
        // Both writes must actually reach the locked name-fill statement before release.
        await waitUntilBlockedOn(sql, ["update", "project_asset_refs", "display_name"], 2);
      } catch (error) {
        probeError = error;
      } finally {
        await gate`ROLLBACK`;
      }
      const settled = await accepts;
      if (probeError !== undefined) throw probeError;
      expect(settled.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
      const results = settled.map((entry) => {
        if (entry.status !== "fulfilled") throw entry.reason;
        return entry.value;
      });
      const persisted = await references(scope.projectId);
      expect(persisted).toHaveLength(1);
      const winner = persisted[0]!.display_name;
      expect(names).toContain(winner);
      expect(persisted).toEqual(before.map((entry) => ({ ...entry, display_name: winner })));
      const expected = initial.references.map((entry) => ({ ...entry, displayName: winner }));
      expect(results.map((entry) => entry.references)).toEqual([expected, expected]);
      expect(results.map((entry) => entry.insertedAssetIds)).toEqual([[], []]);
      const repeated = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
        projectId: scope.projectId, assetIds: [media.id], displayNames: { [media.id]: "After competition.mp4" },
      });
      expect(repeated.references).toEqual(expected);
      expect(repeated.insertedAssetIds).toEqual([]);
      expect(await references(scope.projectId)).toEqual(persisted);
    } finally {
      try {
        await gate.end({ timeout: 1 });
      } finally {
        await Promise.allSettled(pending);
      }
    }
  });

  it("joins the supplied business transaction and rolls back its accepted batch", async () => {
    const scope = await fixture();
    const media = await asset(scope);
    const rollback = new Error("rollback detailed acceptance");
    await expect(db.transaction(async (tx) => {
      const result = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
        projectId: scope.projectId, assetIds: [media.id], displayNames: { [media.id]: "Transaction.mp4" },
      }, tx);
      expect(result.insertedAssetIds).toEqual([media.id]);
      expect(result.references.map((entry) => entry.assetId)).toEqual([media.id]);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await references(scope.projectId)).toEqual([]);
  });

  it("rolls back a name fill with its enclosing business transaction", async () => {
    const scope = await fixture();
    const media = await asset(scope);
    const initial = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({ projectId: scope.projectId, assetIds: [media.id] });
    const before = await references(scope.projectId);
    const rollback = new Error("rollback detailed name fill");
    await expect(db.transaction(async (tx) => {
      const result = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
        projectId: scope.projectId, assetIds: [media.id], displayNames: { [media.id]: "Uncommitted.mp4" },
      }, tx);
      expect(result.insertedAssetIds).toEqual([]);
      expect(result.references).toEqual(initial.references.map((entry) => ({ ...entry, displayName: "Uncommitted.mp4" })));
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await references(scope.projectId)).toEqual(before);
  });

  it("rolls back every new association when one valid asset insert fails", async () => {
    const scope = await fixture();
    const first = await asset(scope);
    const second = await asset(scope);
    const sorted = [first.id, second.id].sort();
    const before = await ledgerRows(sorted);
    await withInsertFailure(scope.projectId, sorted[1]!, async () => {
      const error = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
        projectId: scope.projectId, assetIds: sorted,
      }).then(() => null, (failure: unknown) => failure);
      expect(errorMessages(error)).toContain("injected detailed association failure");
    });
    expect(await references(scope.projectId)).toEqual([]);
    expect(await ledgerRows(sorted)).toEqual(before);
  });

  it("preserves existing references after another association in the batch fails", async () => {
    const scope = await fixture();
    const existing = await asset(scope);
    const incoming = await asset(scope);
    await projectAssetReferenceService.recordProjectAssetReferences({
      projectId: scope.projectId, assetIds: [existing.id], displayNames: { [existing.id]: "Retained.mp4" },
    });
    const before = await references(scope.projectId);
    await withInsertFailure(scope.projectId, incoming.id, async () => {
      const error = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
        projectId: scope.projectId, assetIds: [existing.id, incoming.id],
      }).then(() => null, (failure: unknown) => failure);
      expect(errorMessages(error)).toContain("injected detailed association failure");
    });
    expect(await references(scope.projectId)).toEqual(before);
  });

  it("keeps the legacy service's exact resolution result shape", async () => {
    const scope = await fixture();
    const media = await asset(scope);
    const input = { projectId: scope.projectId, assetIds: [media.id], urls: [media.fileUrl] };
    const detailed = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed(input);
    const legacy = await projectAssetReferenceService.referenceRegisteredProjectMedia(input);
    expect(Object.keys(legacy).sort()).toEqual(["resolved", "unavailable"]);
    expect(legacy).toEqual(detailed.resolution);
    expect(legacy.unavailable).toEqual([]);
    expect((await references(scope.projectId)).map((entry) => entry.asset_id)).toEqual([media.id]);
  });

  it("keeps inserted counts idempotent under generated duplicate and source orders", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("id", "url"), { minLength: 1, maxLength: 12 }),
      async (choices) => {
        const scope = await fixture();
        const media = await asset(scope);
        const input = {
          projectId: scope.projectId,
          assetIds: choices.filter((choice) => choice === "id").map(() => media.id),
          urls: choices.filter((choice) => choice === "url").map(() => media.fileUrl),
        };
        const first = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed(input);
        expect(first.insertedAssetIds).toEqual([media.id]);
        expect(first.references.map((entry) => entry.assetId)).toEqual([media.id]);
        const before = await references(scope.projectId);
        const inspected = await projectAssetReferenceService.inspectRegisteredProjectMedia(input);
        expect(inspected.references).toEqual(first.references);
        const second = await projectAssetReferenceService.referenceRegisteredProjectMediaDetailed({
          ...input, assetIds: [...input.assetIds].reverse(), urls: [...input.urls].reverse(),
        });
        expect(second.insertedAssetIds).toEqual([]);
        expect(second.references).toEqual(first.references);
        expect(await references(scope.projectId)).toEqual(before);
      },
    ), { numRuns: 8 });
  });
});
