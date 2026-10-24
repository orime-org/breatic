// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Timeline persistence RPC service with real membership and real Yjs SQL bytes
 * (inner#1707). Only the store scheduler is injected: its gated success path
 * actually writes a captured update through the real repository. This covers
 * the service boundary, not the later WebSocket dispatcher or browser flow.
 */

import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import * as Y from "yjs";
import { createPgClient, createTestDb, encodeInitialMetaState, initCore, loadLocales } from "@breatic/core";
import {
  applyTimelineEdit, initializeTimelineDocument, projectMetaDocName, timelineSpaceDocName,
  TimelinePersistenceRequestSchema, TimelinePersistenceResponseSchema,
} from "@breatic/shared";
import type {
  NativeEditRecord, TimelinePersistenceRequest, TimelinePersistenceResponse, TimelineStoreAttempt,
} from "@breatic/shared";
import { handleTimelinePersistenceRpc } from "@collab/services/timeline-persistence.js";
import type { TimelinePersistenceContext } from "@collab/services/timeline-persistence.js";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

interface Fixture {
  ownerId: string; editorId: string; viewerId: string;
  studioId: string; projectId: string; documentName: string; document: Y.Doc;
}

type Store = (name: string) => Promise<TimelineStoreAttempt>;
type FailureCode = "FORBIDDEN" | "NOT_FOUND" | "UNSUPPORTED_DOCUMENT" | "INTERNAL";
let business: ReturnType<typeof createPgClient>;
let inspection: ReturnType<typeof createTestDb>;
const owned = { users: [] as string[], studios: [] as string[], projects: [] as string[], documents: [] as string[] };
const localDocuments = new Set<Y.Doc>();

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  business = createPgClient(inject("DATABASE_URL"), { name: "timeline-persistence-rpc-fixtures", max: 3, prepare: false });
  inspection = createTestDb(inject("YJS_DATABASE_URL"));
});

afterEach(async () => {
  try {
    if (owned.documents.length > 0) {
      await inspection.client`DELETE FROM yjs_documents WHERE name = ANY(${owned.documents}::text[])`;
    }
    if (owned.projects.length > 0) {
      await business`UPDATE project_members SET deleted_at = now() WHERE project_id = ANY(${owned.projects}::uuid[])`;
      await business`UPDATE projects SET deleted_at = now() WHERE id = ANY(${owned.projects}::uuid[])`;
    }
    if (owned.studios.length > 0) {
      await business`UPDATE studio_members SET deleted_at = now() WHERE studio_id = ANY(${owned.studios}::uuid[])`;
      await business`UPDATE studios SET deleted_at = now() WHERE id = ANY(${owned.studios}::uuid[])`;
    }
    if (owned.users.length > 0) await business`UPDATE users SET deleted_at = now() WHERE id = ANY(${owned.users}::uuid[])`;
  } finally {
    for (const document of localDocuments) document.destroy();
    localDocuments.clear();
    for (const ids of Object.values(owned)) ids.length = 0;
  }
});

afterAll(async () => {
  await business.end({ timeout: 1 });
  await inspection.client.end({ timeout: 1 });
});

/**
 * Allocate a local document independently of the persisted row.
 * @returns The tracked document.
 */
function document(): Y.Doc {
  const doc = new Y.Doc();
  localDocuments.add(doc);
  return doc;
}

/**
 * Insert a user with a unique fixture email and no implicit Project access.
 * @returns The new identity.
 * @throws {Error} When the real fixture write fails.
 */
async function user(): Promise<string> {
  const id = randomUUID();
  await business`INSERT INTO users (id, email, email_verified) VALUES (${id}, ${`timeline-save-${id}@example.com`}, true)`;
  owned.users.push(id);
  return id;
}

/**
 * Seed real current membership, a live Studio and a persisted empty V1.
 * @returns The identities and a separate local editing document.
 * @throws {Error} When a fixture write fails.
 */
async function fixture(): Promise<Fixture> {
  const ownerId = await user();
  const editorId = await user();
  const viewerId = await user();
  const studioId = randomUUID();
  const projectId = randomUUID();
  const spaceId = randomUUID();
  await business`INSERT INTO studios (id, created_by_user_id, slug, type, name)
    VALUES (${studioId}, ${ownerId}, ${studioId}, 'personal', 'Timeline save test')`;
  owned.studios.push(studioId);
  await business`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${ownerId}, 'admin')`;
  await business`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug, initial_space_type)
    VALUES (${projectId}, ${studioId}, ${ownerId}, 'Timeline save test', ${projectId}, 'timeline')`;
  owned.projects.push(projectId);
  for (const [id, role] of [[ownerId, "owner"], [editorId, "editor"], [viewerId, "viewer"]] as const) {
    await business`INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${id}, ${role}, null)`;
  }
  const doc = document();
  initializeTimelineDocument(doc, { width: 1920, height: 1080, fps: { num: 24, den: 1 } });
  const documentName = timelineSpaceDocName(projectId, spaceId);
  const metaName = projectMetaDocName(projectId);
  owned.documents.push(documentName, metaName);
  await yjsRepo.seedInitialState(documentName, Y.encodeStateAsUpdate(doc));
  await yjsRepo.seedInitialState(metaName, encodeInitialMetaState({
    spaceId, kind: "timeline", name: "Timeline", createdBy: ownerId, ts: 1,
  }));
  return { ownerId, editorId, viewerId, studioId, projectId, documentName, document: doc };
}

/**
 * Append an accepted logical video placement only to the local document.
 * @returns The full immutable record whose persistence is being queried.
 * @throws {Error} When the supplied edit violates the Timeline contract.
 */
function appendVideo(target: Fixture, startFrame = 0): NativeEditRecord {
  const source = {
    id: randomUUID(), kind: "video" as const, assetId: randomUUID(),
    timebase: { num: 24, den: 1 }, extentFrames: 240,
    durationSeconds: "10", durationOrigin: "registered" as const,
  };
  return applyTimelineEdit(target.document, {
    actionId: randomUUID(), operation: "add_video",
    parameters: { source, clip: {
      id: randomUUID(), kind: "video", trackId: "visual-1", sourceId: source.id,
      startFrame, sourceInFrame: 0, durationFrames: 24, rate: { num: 1, den: 1 },
      gain: 1, mute: false, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    } },
  });
}

/**
 * Construct a request through the actual strict shared input boundary.
 * @returns The validated, connection-scoped request.
 * @throws {Error} When the generated request is invalid.
 */
function request(kind: "query" | "retry", actionIds: string[] = []): TimelinePersistenceRequest {
  return TimelinePersistenceRequestSchema.parse({
    version: 1, id: randomUUID(), type: `timeline:persistence:${kind}`, payload: { actionIds },
  });
}

/**
 * Stand for an authenticated content connection without accepting wire identity.
 * @returns The handler's connection context.
 */
function connection(target: Fixture, requestStore: Store, userId = target.ownerId, readOnly = false): TimelinePersistenceContext {
  return { documentName: target.documentName, userId, readOnly, requestStore };
}

/**
 * Assert complete successful results, keeping attempts separate from inclusion.
 * @throws {Error} When response validation or the expected result fails.
 */
function expectResult(response: TimelinePersistenceResponse, input: TimelinePersistenceRequest,
  persistedRecords: NativeEditRecord[], missingActionIds: string[], attempt?: TimelineStoreAttempt): void {
  TimelinePersistenceResponseSchema.parse(response);
  expect(response).toEqual({
    version: 1, id: input.id, type: "timeline:persistence:result", ok: true,
    result: { documentVersion: 1, persistedRecords, missingActionIds, ...(attempt === undefined ? {} : { attempt }) },
  });
}

/**
 * Assert the precise refusal without binding the test to localized error copy.
 * @throws {Error} When the response does not match the refusal contract.
 */
function expectFailure(response: TimelinePersistenceResponse, input: TimelinePersistenceRequest, code: FailureCode): void {
  TimelinePersistenceResponseSchema.parse(response);
  expect(response).toEqual({
    version: 1, id: input.id, type: "timeline:persistence:result", ok: false,
    error: { code, message: expect.any(String) },
  });
}

/**
 * Read immutable byte and timestamp evidence for a query's lack of writes.
 * @returns The actual row projection, with bytes normalized for equality.
 * @throws {Error} When a row expected by the fixture is absent.
 */
async function row(name: string): Promise<{ data: number[]; updatedAt: string | null; deletedAt: string | null }> {
  const [stored] = await inspection.client<{ data: Uint8Array; updatedAt: string | null; deletedAt: string | null }[]>`
    SELECT data, updated_at::text AS "updatedAt", deleted_at::text AS "deletedAt"
    FROM yjs_documents WHERE name = ${name}
  `;
  if (stored === undefined) throw new Error("Expected the fixture's Yjs row");
  return { data: Array.from(stored.data), updatedAt: stored.updatedAt, deletedAt: stored.deletedAt };
}

describe("Timeline persistence query reads actual database records", () => {
  it("reports an edit present only in memory as missing and performs no query write", async () => {
    const target = await fixture();
    const edit = appendVideo(target);
    const store = vi.fn(async (): Promise<TimelineStoreAttempt> => "stored");
    const input = request("query", [edit.actionId]);
    const before = await row(target.documentName);
    expectResult(await handleTimelinePersistenceRpc(connection(target, store), input), input, [], [edit.actionId]);
    expect(target.document.getMap("nativeEdits").get(edit.actionId)).toEqual(edit);
    expect(await row(target.documentName)).toEqual(before);
    expect(store).not.toHaveBeenCalled();
  });

  it("returns the complete persisted applied and not-applied records to a Viewer", async () => {
    const target = await fixture();
    const applied = appendVideo(target);
    const rejected = applyTimelineEdit(target.document, {
      actionId: randomUUID(), operation: "set_start", parameters: { clipId: randomUUID(), startFrame: 120 },
    });
    expect(rejected.effect).toBe("not_applied");
    await yjsRepo.upsertDocData(target.documentName, Y.encodeStateAsUpdate(target.document));
    const store = vi.fn(async (): Promise<TimelineStoreAttempt> => "stored");
    const input = request("query", [applied.actionId, rejected.actionId]);
    expectResult(await handleTimelinePersistenceRpc(connection(target, store, target.viewerId, true), input), input, [applied, rejected], []);
    expect(store).not.toHaveBeenCalled();
  });

  it("checks persisted V1 even when the action set is empty", async () => {
    const target = await fixture();
    const store = vi.fn(async (): Promise<TimelineStoreAttempt> => "stored");
    const input = request("query");
    expectResult(await handleTimelinePersistenceRpc(connection(target, store), input), input, [], []);
    expect(store).not.toHaveBeenCalled();
  });

  it("returns only requested SQL records for arbitrary duplicated and missing ids", async () => {
    const target = await fixture();
    const edits = [appendVideo(target, 0), appendVideo(target, 24), appendVideo(target, 48)];
    await yjsRepo.upsertDocData(target.documentName, Y.encodeStateAsUpdate(target.document));
    const candidates = [...edits.map((edit) => edit.actionId), randomUUID(), randomUUID()];
    const store = vi.fn(async (): Promise<TimelineStoreAttempt> => "stored");
    const before = await row(target.documentName);
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...candidates), { maxLength: 8 }), async (ids) => {
      const input = request("query", ids);
      const response = TimelinePersistenceResponseSchema.parse(await handleTimelinePersistenceRpc(connection(target, store, target.viewerId, true), input));
      expect(response.ok).toBe(true);
      if (!response.ok) throw new Error("A current Viewer must be allowed to query");
      const wanted = new Set(input.payload.actionIds);
      const expected = edits.filter((edit) => wanted.has(edit.actionId));
      expect(response.result.documentVersion).toBe(1);
      expect(response.result.persistedRecords.length).toBe(expected.length);
      expect(Object.fromEntries(response.result.persistedRecords.map((edit) => [edit.actionId, edit]))).toEqual(
        Object.fromEntries(expected.map((edit) => [edit.actionId, edit])),
      );
      expect([...response.result.missingActionIds].sort()).toEqual(input.payload.actionIds.filter((id) => !edits.some((edit) => edit.actionId === id)).sort());
      expect(response.result.attempt).toBeUndefined();
    }), { numRuns: 16 });
    expect(await row(target.documentName)).toEqual(before);
    expect(store).not.toHaveBeenCalled();
  });

  it.each(["missing", "soft-deleted"] as const)("does not seed a %s SQL row while querying", async (state) => {
    const target = await fixture();
    const ctx = {
      ...connection(target, vi.fn(async (): Promise<TimelineStoreAttempt> => "stored")),
      documentName: state === "missing" ? timelineSpaceDocName(target.projectId, randomUUID()) : target.documentName,
    };
    if (state === "soft-deleted") expect(await yjsRepo.softDeleteByName(target.documentName)).toBe(true);
    const input = request("query");
    expectFailure(await handleTimelinePersistenceRpc(ctx, input), input, "NOT_FOUND");
    expect(await yjsRepo.fetchDocData(ctx.documentName)).toBeNull();
    expect(ctx.requestStore).not.toHaveBeenCalled();
  });

  it("preserves an unsupported stored version and reports it instead of manufacturing saved", async () => {
    const target = await fixture();
    target.document.getMap("timeline").set("schemaVersion", 2);
    await yjsRepo.upsertDocData(target.documentName, Y.encodeStateAsUpdate(target.document));
    const before = await row(target.documentName);
    const store = vi.fn(async (): Promise<TimelineStoreAttempt> => "stored");
    const input = request("query");
    expectFailure(await handleTimelinePersistenceRpc(connection(target, store), input), input, "UNSUPPORTED_DOCUMENT");
    expect(await row(target.documentName)).toEqual(before);
    expect(store).not.toHaveBeenCalled();
  });
});

describe("Timeline persistence retry waits for one actual store attempt", () => {
  it("waits for the captured SQL write, confirming only records in that snapshot", async () => {
    const target = await fixture();
    const captured = appendVideo(target);
    const capturedBytes = Y.encodeStateAsUpdate(target.document);
    const later = appendVideo(target, 24);
    const gate = await inspection.client.reserve();
    let pendingStore: Promise<PromiseSettledResult<void>[]> = Promise.resolve([]);
    let rpc: Promise<TimelinePersistenceResponse> | undefined;
    let released = false;
    let entered!: () => void;
    const storeEntered = new Promise<void>((resolve) => { entered = resolve; });
    let returned = false;
    try {
      await gate`BEGIN`;
      await gate`SELECT name FROM yjs_documents WHERE name = ${target.documentName} FOR UPDATE`;
      pendingStore = Promise.allSettled([yjsRepo.upsertDocData(target.documentName, capturedBytes)]);
      await waitUntilBlockedOn(inspection.client, ["yjs_documents", "for update"], 1);
      const store = vi.fn(async (name: string): Promise<TimelineStoreAttempt> => {
        expect(name).toBe(target.documentName);
        entered();
        const [outcome] = await pendingStore;
        if (outcome?.status !== "fulfilled") throw new Error("The real captured store failed");
        return "stored";
      });
      const input = request("retry", [captured.actionId, later.actionId]);
      rpc = handleTimelinePersistenceRpc(connection(target, store, target.editorId), input).then((response) => { returned = true; return response; });
      expect(await Promise.race([storeEntered.then(() => "requested"), rpc.then(() => "returned")])).toBe("requested");
      expect(returned).toBe(false);
      const bytes = await yjsRepo.fetchDocData(target.documentName);
      if (bytes === null) throw new Error("The pre-store SQL row must exist");
      const before = document();
      Y.applyUpdate(before, bytes);
      expect(before.getMap("nativeEdits").toJSON()).toEqual({});
      await gate`ROLLBACK`;
      released = true;
      expectResult(await rpc, input, [captured], [later.actionId], "stored");
      expect(store).toHaveBeenCalledTimes(1);
      expect(target.document.getMap("nativeEdits").size).toBe(2);
    } finally {
      try { if (!released) await gate`ROLLBACK`; } finally { gate.release(); await pendingStore; if (rpc !== undefined) await Promise.allSettled([rpc]); }
    }
  });

  it.each(["stored", "refused", "deferred", "gone"] as const)("does not infer record inclusion from a %s attempt", async (attempt) => {
    const target = await fixture();
    const edit = appendVideo(target);
    const before = await row(target.documentName);
    const store = vi.fn(async (): Promise<TimelineStoreAttempt> => attempt);
    const input = request("retry", [edit.actionId]);
    expectResult(await handleTimelinePersistenceRpc(connection(target, store, target.editorId), input), input, [], [edit.actionId], attempt);
    expect(store.mock.calls).toEqual([[target.documentName]]);
    expect(await row(target.documentName)).toEqual(before);
  });

  it("still confirms an existing SQL record when the current store attempt is refused", async () => {
    const target = await fixture();
    const edit = appendVideo(target);
    await yjsRepo.upsertDocData(target.documentName, Y.encodeStateAsUpdate(target.document));
    const store = vi.fn(async (): Promise<TimelineStoreAttempt> => "refused");
    const input = request("retry", [edit.actionId]);
    expectResult(await handleTimelinePersistenceRpc(connection(target, store), input), input, [edit], [], "refused");
    expect(store.mock.calls).toEqual([[target.documentName]]);
  });

  it.each(["owner", "editor"] as const)("allows a current writable %s to store and then query SQL", async (role) => {
    const target = await fixture();
    const edit = appendVideo(target);
    const store = vi.fn(async (name: string): Promise<TimelineStoreAttempt> => {
      await yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(target.document));
      return "stored";
    });
    const input = request("retry", [edit.actionId]);
    const actor = role === "owner" ? target.ownerId : target.editorId;
    expectResult(await handleTimelinePersistenceRpc(connection(target, store, actor), input), input, [edit], [], "stored");
    expect(store.mock.calls).toEqual([[target.documentName]]);
  });

  it("returns INTERNAL when the scheduler fails without inventing saved records", async () => {
    const target = await fixture();
    const before = await row(target.documentName);
    const store = vi.fn(async (): Promise<TimelineStoreAttempt> => { throw new Error("Store scheduler failed"); });
    const input = request("retry", [randomUUID()]);
    expectFailure(await handleTimelinePersistenceRpc(connection(target, store), input), input, "INTERNAL");
    expect(await row(target.documentName)).toEqual(before);
  });
});

describe("Timeline persistence current connection scope and permissions", () => {
  it.each(["viewer", "readonly-editor", "readonly-owner"] as const)("refuses retry for %s without running storage", async (kind) => {
    const target = await fixture();
    const store = vi.fn(async (): Promise<TimelineStoreAttempt> => "stored");
    const actor = kind === "viewer" ? target.viewerId : kind === "readonly-editor" ? target.editorId : target.ownerId;
    const input = request("retry");
    const before = await row(target.documentName);
    expectFailure(await handleTimelinePersistenceRpc(connection(target, store, actor, kind !== "viewer"), input), input, "FORBIDDEN");
    expect(store).not.toHaveBeenCalled();
    expect(await row(target.documentName)).toEqual(before);
  });

  it.each(["viewer", "removed"] as const)("rechecks a stale Editor connection after membership becomes %s", async (kind) => {
    const target = await fixture();
    const store = vi.fn(async (): Promise<TimelineStoreAttempt> => "stored");
    const ctx = connection(target, store, target.editorId);
    const initial = request("query");
    expectResult(await handleTimelinePersistenceRpc(ctx, initial), initial, [], []);
    if (kind === "viewer") await business`UPDATE project_members SET role = 'viewer' WHERE project_id = ${target.projectId} AND user_id = ${target.editorId}`;
    else await business`UPDATE project_members SET deleted_at = now() WHERE project_id = ${target.projectId} AND user_id = ${target.editorId}`;
    const query = request("query");
    const response = await handleTimelinePersistenceRpc(ctx, query);
    if (kind === "viewer") expectResult(response, query, [], []);
    else expectFailure(response, query, "FORBIDDEN");
    const retry = request("retry");
    expectFailure(await handleTimelinePersistenceRpc(ctx, retry), retry, "FORBIDDEN");
    expect(store).not.toHaveBeenCalled();
  });

  it("lets an archived Project be queried while refusing even its stale writable owner", async () => {
    const target = await fixture();
    await business`UPDATE projects SET archived_at = now(), archived_by_user_id = ${target.ownerId} WHERE id = ${target.projectId}`;
    const store = vi.fn(async (): Promise<TimelineStoreAttempt> => "stored");
    const ctx = connection(target, store);
    const query = request("query");
    expectResult(await handleTimelinePersistenceRpc(ctx, query), query, [], []);
    const retry = request("retry");
    expectFailure(await handleTimelinePersistenceRpc(ctx, retry), retry, "FORBIDDEN");
    expect(store).not.toHaveBeenCalled();
  });

  it.each(["Project", "Studio"] as const)("refuses query and retry after its %s was soft-deleted", async (kind) => {
    const target = await fixture();
    if (kind === "Project") await business`UPDATE projects SET deleted_at = now() WHERE id = ${target.projectId}`;
    else await business`UPDATE studios SET deleted_at = now() WHERE id = ${target.studioId}`;
    const store = vi.fn(async (): Promise<TimelineStoreAttempt> => "stored");
    const before = await row(target.documentName);
    for (const action of ["query", "retry"] as const) {
      const input = request(action);
      expectFailure(await handleTimelinePersistenceRpc(connection(target, store), input), input, "FORBIDDEN");
    }
    expect(store).not.toHaveBeenCalled();
    expect(await row(target.documentName)).toEqual(before);
  });

  it("does not reveal another Project's receipts to a user without its membership", async () => {
    const home = await fixture();
    const other = await fixture();
    const secret = appendVideo(other);
    await yjsRepo.upsertDocData(other.documentName, Y.encodeStateAsUpdate(other.document));
    const store = vi.fn(async (): Promise<TimelineStoreAttempt> => "stored");
    for (const action of ["query", "retry"] as const) {
      const input = request(action, [secret.actionId]);
      expectFailure(await handleTimelinePersistenceRpc(connection(other, store, home.ownerId), input), input, "FORBIDDEN");
    }
    expect(store).not.toHaveBeenCalled();
  });

  it.each(["meta", "canvas", "document", "invalid"] as const)("refuses the %s connection namespace", async (kind) => {
    const target = await fixture();
    const store = vi.fn(async (): Promise<TimelineStoreAttempt> => "stored");
    const ctx = {
      ...connection(target, store),
      documentName: kind === "invalid" ? "not-a-project-document"
        : kind === "meta" ? projectMetaDocName(target.projectId) : `project-${target.projectId}/${kind}-${randomUUID()}`,
    };
    for (const action of ["query", "retry"] as const) {
      const input = request(action);
      expectFailure(await handleTimelinePersistenceRpc(ctx, input), input, "FORBIDDEN");
    }
    expect(store).not.toHaveBeenCalled();
  });
});
