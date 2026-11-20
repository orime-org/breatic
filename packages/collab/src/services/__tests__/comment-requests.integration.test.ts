// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Comment requests (breatic#1488 §11.9, §15.8, §15.10, §15.11): the browser
 * asks collab to record a mention, a hand-over or a cancelled hand-over on the
 * Space document's own connection, and collab writes the record and its
 * notification while it handles the request; an external agent's reply marks
 * the hand-over answered while its command runs. Deleting and restoring the
 * Space voids and restores the records under the same lock. Storing a Space
 * writes no records.
 */

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { sql as dsql } from "drizzle-orm";

import { agentAccessService, env, getMcpRedis, getStreamRedis, type ProjectRole } from "@breatic/core";
import {
  assignmentsChangedChannel,
  canvasSpaceDocName,
  documentBodyFragment,
  documentCommentThreads,
  documentSpaceDocName,
  mcpNewAssignmentsKey,
  notificationsChangedChannel,
  projectMetaDocName,
  type CommentRequest,
  type CommentResponse,
} from "@breatic/shared";
import { addNodeInDoc, createAnnotationNode, nodeDataMap } from "@breatic/shared/canvas-model";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import { storeDoc } from "@collab/services/persistence.js";
import { handleSpaceRpc } from "@collab/services/space-rpc.js";
import { handleCommentRequest } from "@collab/services/comment-requests.js";
import {
  call,
  consumeOn,
  harness,
  readCanvas,
  resultOf,
  run,
  seedWorld,
  useAgentCommandHarness,
  type World,
} from "@collab/services/__tests__/agent-command-harness.js";

useAgentCommandHarness();

/** A world whose canvas holds one annotation the owner wrote. */
type NoteWorld = World & { noteId: string };

/**
 * A world with one annotation the owner wrote on its canvas.
 * @param role - The member's role.
 * @param data - More fields for the annotation's data, set on the copy an
 *   instance has loaded; gets the member's, the owner's and the project's ids.
 * @returns The world and the annotation's id.
 */
async function seedNote(
  role: "owner" | "editor" | "viewer" = "editor",
  data?: (userId: string, ownerId: string, projectId: string) => Record<string, unknown>,
): Promise<NoteWorld> {
  let noteId = "";
  const world = await seedWorld(role, (canvas, _userId, ownerId) => {
    const note = createAnnotationNode({ x: 0, y: 400 }, ownerId, "Shorter?");
    noteId = note.id;
    addNodeInDoc(canvas, note);
  });
  if (data) {
    await readCanvas(harness.instanceA, world, (doc) => {
      const map = nodeDataMap(doc, noteId)!;
      for (const [key, value] of Object.entries(data(world.userId, world.ownerId, world.projectId))) map.set(key, value);
    });
  }
  return { ...world, noteId };
}

/**
 * Send one comment request the way the Space document's connection hands it
 * to collab: against the document loaded on an instance.
 * @param world - Whose Space.
 * @param request - The request without its id.
 * @param options - Who asks, and which Space kind.
 * @param options.caller - Who asks; the world's member by default.
 * @param options.kind - The Space kind; canvas by default.
 * @returns What collab answered.
 */
async function ask(
  world: World,
  request: Omit<CommentRequest, "id">,
  options: { caller?: { userId: string; role: ProjectRole }; kind?: "canvas" | "document" } = {},
): Promise<CommentResponse> {
  const kind = options.kind ?? "canvas";
  const name = kind === "canvas" ? canvasSpaceDocName(world.projectId, world.spaceId) : documentSpaceDocName(world.projectId, world.spaceId);
  const conn = await harness.instanceA.openDirectConnection(name, {});
  try {
    const doc = harness.instanceA.documents.get(name);
    if (!doc) throw new Error(`${name} is not loaded`);
    const [member] = await run<{ role: ProjectRole }>(dsql`SELECT role FROM project_members WHERE project_id = ${world.projectId} AND user_id = ${world.userId}`);
    const caller = options.caller ?? { userId: world.userId, role: member!.role };
    return await handleCommentRequest({ projectId: world.projectId, spaceId: world.spaceId, kind, doc }, caller, { id: randomUUID(), ...request } as CommentRequest);
  } finally {
    await conn.disconnect();
  }
}

/**
 * A hand-over request for the world's annotation.
 * @param world - Whose annotation.
 * @param connectionId - Which connection; the world's by default.
 * @returns The request.
 */
function handOver(world: NoteWorld, connectionId = world.connectionId): Omit<CommentRequest, "id"> {
  return { type: "comment:hand-over", payload: { spaceId: world.spaceId, threadId: world.noteId, connectionId } };
}

/**
 * A project's rows of one table.
 * @param table - `comment_mentions` or `comment_assignments`.
 * @param world - Whose project.
 * @returns The rows.
 */
async function rows(table: "comment_mentions" | "comment_assignments", world: World): Promise<Array<Record<string, unknown>>> {
  return run(dsql`SELECT * FROM ${dsql.raw(table)} WHERE project_id = ${world.projectId} ORDER BY created_at`);
}

/**
 * A user's notifications of one type.
 * @param userId - Whose.
 * @param type - Which type.
 * @returns Their payloads.
 */
async function notified(userId: string, type: string): Promise<unknown[]> {
  const found = await run<{ payload: unknown }>(dsql`SELECT payload FROM notifications WHERE user_id = ${userId} AND type = ${type}`);
  return found.map((r) => r.payload);
}

/**
 * The members of one connection's new-assignments set.
 * @param connectionId - The connection.
 * @returns Its members, sorted.
 */
async function newAssignments(connectionId: string): Promise<string[]> {
  return (await getMcpRedis().smembers(mcpNewAssignmentsKey(env.REDIS_KEY_PREFIX, connectionId))).sort();
}

/**
 * The set member for one thread.
 * @param world - Whose project and Space.
 * @param threadId - The thread.
 * @returns The member.
 */
function member(world: World, threadId: string): string {
  return `${world.projectId}:${world.spaceId}:${threadId}`;
}

/**
 * Listen on a channel while a step runs.
 * @param channel - The channel.
 * @param step - What to run.
 * @returns The messages heard, parsed.
 */
async function heardOn(channel: string, step: () => Promise<void>): Promise<unknown[]> {
  const subscriber = getStreamRedis().duplicate();
  const heard: unknown[] = [];
  subscriber.on("message", (_channel: string, message: string) => heard.push(JSON.parse(message)));
  await subscriber.subscribe(channel);
  try {
    await step();
    await new Promise((resolve) => setTimeout(resolve, 200));
    return heard;
  } finally {
    await subscriber.quit();
  }
}

/**
 * Give the world's project a second canvas Space, so the first may be deleted.
 * @param world - Whose project.
 */
async function addSecondSpace(world: World): Promise<void> {
  const metaName = projectMetaDocName(world.projectId);
  const meta = new Y.Doc();
  Y.applyUpdate(meta, (await yjsRepo.fetchDocData(metaName))!);
  const other = new Y.Map<unknown>();
  const otherId = randomUUID();
  meta.getMap("spaces").set(otherId, other);
  await yjsRepo.upsertDocData(canvasSpaceDocName(world.projectId, otherId), Y.encodeStateAsUpdate(new Y.Doc()));
  other.set("type", "canvas");
  other.set("name", "Other");
  other.set("order", 1);
  await yjsRepo.upsertDocData(metaName, Y.encodeStateAsUpdate(meta));
}

/**
 * Delete or restore the world's Space as the project's owner.
 * @param world - Whose Space.
 * @param type - Delete or restore.
 * @returns Whether it went through.
 */
async function spaceRpc(world: World, type: "space:delete" | "space:restore"): Promise<boolean> {
  return (await handleSpaceRpc({ hocuspocus: harness.instanceA }, world.projectId, { userId: world.ownerId, role: "owner" }, {
    id: randomUUID(),
    type,
    payload: { spaceId: world.spaceId },
  })).ok;
}

describe("comment:mentioned", () => {
  it("records each member an entry mentions and notifies them once, however often it is asked", async () => {
    const world = await seedNote("editor", (userId, _ownerId, projectId) => ({
      mentions: [{ userId, projectId, mentionedAt: 1_000, label: "@Member" }],
    }));
    // The owner wrote the note; ask as the owner.
    const caller = { userId: world.ownerId, role: "owner" as const };
    const request = { type: "comment:mentioned", payload: { spaceId: world.spaceId, entryId: world.noteId } } as const;
    expect(await ask(world, request, { caller })).toMatchObject({ ok: true });
    expect(await ask(world, request, { caller })).toMatchObject({ ok: true });
    expect(await rows("comment_mentions", world)).toEqual([
      expect.objectContaining({ entry_id: world.noteId, thread_id: world.noteId, user_id: world.userId, author_id: world.ownerId, deleted_at: null, notified_at: expect.any(String) }),
    ]);
    expect(await notified(world.userId, "comment.mentioned")).toEqual([
      { projectId: world.projectId, spaceId: world.spaceId, entryId: world.noteId, threadId: world.noteId, authorId: world.ownerId },
    ]);
  });

  it("tells the mentioned member's bell that their notifications changed", async () => {
    const world = await seedNote("editor", (userId, _ownerId, projectId) => ({
      mentions: [{ userId, projectId, mentionedAt: 1_000, label: "@Member" }],
    }));
    const heard = await heardOn(notificationsChangedChannel(env.REDIS_KEY_PREFIX), async () => {
      await ask(world, { type: "comment:mentioned", payload: { spaceId: world.spaceId, entryId: world.noteId } }, { caller: { userId: world.ownerId, role: "owner" } });
    });
    expect(heard).toEqual([expect.objectContaining({ type: "notifications:changed", userIds: [world.userId] })]);
  });

  it("keeps the record when the words are later edited away, and notifies nobody again", async () => {
    const world = await seedNote("editor", (userId, _ownerId, projectId) => ({
      mentions: [{ userId, projectId, mentionedAt: 1_000, label: "@Member" }],
    }));
    const caller = { userId: world.ownerId, role: "owner" as const };
    const request = { type: "comment:mentioned", payload: { spaceId: world.spaceId, entryId: world.noteId } } as const;
    await ask(world, request, { caller });
    await readCanvas(harness.instanceA, world, (doc) => nodeDataMap(doc, world.noteId)!.set("mentions", []));
    expect(await ask(world, request, { caller })).toMatchObject({ ok: true });
    expect((await rows("comment_mentions", world))[0]).toMatchObject({ deleted_at: null });
    expect(await notified(world.userId, "comment.mentioned")).toHaveLength(1);
  });

  it("notifies neither someone who mentions themselves nor someone outside the project", async () => {
    const [outsider] = await run<{ id: string }>(dsql`INSERT INTO users (email, email_verified) VALUES (${`out-${randomUUID()}@example.com`}, true) RETURNING id`);
    const world = await seedNote("editor", (_userId, ownerId, projectId) => ({
      mentions: [
        { userId: ownerId, projectId, mentionedAt: 1, label: "@me" },
        { userId: outsider!.id, projectId, mentionedAt: 1, label: "@out" },
      ],
    }));
    await ask(world, { type: "comment:mentioned", payload: { spaceId: world.spaceId, entryId: world.noteId } }, { caller: { userId: world.ownerId, role: "owner" } });
    expect(await rows("comment_mentions", world)).toHaveLength(2);
    expect(await notified(world.ownerId, "comment.mentioned")).toEqual([]);
    expect(await notified(outsider!.id, "comment.mentioned")).toEqual([]);
  });

  it("refuses an entry the document does not hold, and a viewer", async () => {
    const world = await seedNote("viewer");
    expect(await ask(world, { type: "comment:mentioned", payload: { spaceId: world.spaceId, entryId: randomUUID() } }, { caller: { userId: world.ownerId, role: "owner" } })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await ask(world, { type: "comment:mentioned", payload: { spaceId: world.spaceId, entryId: world.noteId } })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await rows("comment_mentions", world)).toEqual([]);
  });
});

describe("comment:hand-over", () => {
  it("records the hand-over as pending, adds it to the connection's new set and announces the change", async () => {
    const world = await seedNote();
    const heard = await heardOn(assignmentsChangedChannel(env.REDIS_KEY_PREFIX, world.projectId), async () => {
      expect(await ask(world, handOver(world))).toMatchObject({ ok: true });
    });
    expect(await rows("comment_assignments", world)).toEqual([
      expect.objectContaining({ thread_id: world.noteId, connection_id: world.connectionId, assigned_by: world.userId, status: "pending", notified_at: null, void_reason: null, deleted_at: null }),
    ]);
    expect(await newAssignments(world.connectionId)).toEqual([member(world, world.noteId)]);
    expect(heard).toEqual([expect.objectContaining({ type: "project-assignments:changed", projectId: world.projectId, spaceId: world.spaceId })]);
  });

  it("writes nothing into the document", async () => {
    const world = await seedNote();
    await ask(world, handOver(world));
    expect(await readCanvas(harness.instanceA, world, (doc) => nodeDataMap(doc, world.noteId)!.get("assignment"))).toBeUndefined();
  });

  it("moves the thread to the connection it is handed to next, out of the first one's set", async () => {
    const world = await seedNote();
    const second = await agentAccessService.createPersonalAccessToken({ userId: world.userId, name: "Codex", expiresAt: null });
    if (!second.ok) throw new Error("cap");
    await ask(world, handOver(world));
    expect(await ask(world, handOver(world, second.connectionId))).toMatchObject({ ok: true });
    expect(await rows("comment_assignments", world)).toEqual([expect.objectContaining({ connection_id: second.connectionId, status: "pending" })]);
    expect(await newAssignments(world.connectionId)).toEqual([]);
    expect(await newAssignments(second.connectionId)).toEqual([member(world, world.noteId)]);
  });

  it("refuses a connection that is not the caller's, one that is disconnected, a thread that is gone and a viewer", async () => {
    const world = await seedNote();
    const owners = await agentAccessService.createPersonalAccessToken({ userId: world.ownerId, name: "Owner's", expiresAt: null });
    if (!owners.ok) throw new Error("cap");
    expect(await ask(world, handOver(world, owners.connectionId))).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const gone = await agentAccessService.createPersonalAccessToken({ userId: world.userId, name: "Gone", expiresAt: null });
    if (!gone.ok) throw new Error("cap");
    await agentAccessService.disconnect(gone.connectionId, world.userId);
    expect(await ask(world, handOver(world, gone.connectionId))).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await ask(world, { type: "comment:hand-over", payload: { spaceId: world.spaceId, threadId: randomUUID(), connectionId: world.connectionId } })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    const viewer = await seedNote("viewer");
    expect(await ask(viewer, handOver(viewer))).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await rows("comment_assignments", world)).toEqual([]);
    expect(await rows("comment_assignments", viewer)).toEqual([]);
  });

  it("refuses a resolved document thread", async () => {
    const world = await seedWorld("owner");
    const documentSpaceId = randomUUID();
    const meta = new Y.Doc();
    Y.applyUpdate(meta, (await yjsRepo.fetchDocData(projectMetaDocName(world.projectId)))!);
    const entry = new Y.Map<unknown>();
    meta.getMap("spaces").set(documentSpaceId, entry);
    entry.set("type", "document");
    entry.set("name", "Script");
    entry.set("order", 1);
    await yjsRepo.upsertDocData(projectMetaDocName(world.projectId), Y.encodeStateAsUpdate(meta));
    const threadId = randomUUID();
    const doc = new Y.Doc();
    const words = new Y.XmlText();
    words.insert(0, "Hello", { comment: { threadId } });
    const para = new Y.XmlElement("paragraph");
    para.insert(0, [words]);
    const container = new Y.XmlElement("blockContainer");
    container.setAttribute("id", "b0");
    container.insert(0, [para]);
    const group = new Y.XmlElement("blockGroup");
    group.insert(0, [container]);
    documentBodyFragment(doc).insert(0, [group]);
    const thread = new Y.Map<unknown>();
    documentCommentThreads(doc).set(threadId, thread);
    thread.set("id", threadId);
    thread.set("resolved", true);
    thread.set("comments", Y.Array.from([{ id: randomUUID(), userId: world.userId, body: [], metadata: {} }]));
    await yjsRepo.upsertDocData(documentSpaceDocName(world.projectId, documentSpaceId), Y.encodeStateAsUpdate(doc));
    const docWorld = { ...world, spaceId: documentSpaceId };
    expect(await ask(docWorld, { type: "comment:hand-over", payload: { spaceId: documentSpaceId, threadId, connectionId: world.connectionId } }, { kind: "document" })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(await rows("comment_assignments", world)).toEqual([]);
  });

  it("refuses a Space whose content row is already deleted", async () => {
    const world = await seedNote();
    await yjsRepo.softDeleteByName(canvasSpaceDocName(world.projectId, world.spaceId));
    expect(await ask(world, handOver(world))).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await rows("comment_assignments", world)).toEqual([]);
    expect(await newAssignments(world.connectionId)).toEqual([]);
  });
});

describe("comment:cancel-hand-over", () => {
  it("voids the hand-over as cancelled and takes it out of the set; handing it over again makes it pending", async () => {
    const world = await seedNote();
    await ask(world, handOver(world));
    expect(await ask(world, { type: "comment:cancel-hand-over", payload: { spaceId: world.spaceId, threadId: world.noteId } })).toMatchObject({ ok: true });
    expect((await rows("comment_assignments", world))[0]).toMatchObject({ void_reason: "cancelled", deleted_at: expect.any(String) });
    expect(await newAssignments(world.connectionId)).toEqual([]);
    expect(await ask(world, handOver(world))).toMatchObject({ ok: true });
    expect((await rows("comment_assignments", world))[0]).toMatchObject({ status: "pending", void_reason: null, deleted_at: null });
  });

  it("refuses anyone but the one who handed it over, and a thread never handed over", async () => {
    const world = await seedNote();
    expect(await ask(world, { type: "comment:cancel-hand-over", payload: { spaceId: world.spaceId, threadId: world.noteId } })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    await ask(world, handOver(world));
    expect(
      await ask(world, { type: "comment:cancel-hand-over", payload: { spaceId: world.spaceId, threadId: world.noteId } }, { caller: { userId: world.ownerId, role: "owner" } }),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect((await rows("comment_assignments", world))[0]).toMatchObject({ status: "pending", deleted_at: null });
  });
});

describe("an external agent's reply", () => {
  it("marks the hand-over answered, tells the one who handed it over once, and takes it out of the set", async () => {
    const world = await seedNote();
    await ask(world, handOver(world));
    consumeOn(world, harness.instanceA);
    const heard = await heardOn(notificationsChangedChannel(env.REDIS_KEY_PREFIX), async () => {
      expect(resultOf<{ answered: boolean }>(await call(world, "comment_on_canvas", { text: "Done", annotationId: world.noteId }))).toMatchObject({ answered: true });
    });
    expect((await rows("comment_assignments", world))[0]).toMatchObject({ status: "answered", notified_at: expect.any(String) });
    expect(await notified(world.userId, "comment.assignment_answered")).toEqual([
      { projectId: world.projectId, spaceId: world.spaceId, threadId: world.noteId, connectionId: world.connectionId },
    ]);
    expect(await newAssignments(world.connectionId)).toEqual([]);
    expect(heard).toEqual([expect.objectContaining({ type: "notifications:changed", userIds: [world.userId] })]);
    expect(resultOf<{ answered: boolean }>(await call(world, "comment_on_canvas", { text: "Also this", annotationId: world.noteId }))).toMatchObject({ answered: false });
    expect(await notified(world.userId, "comment.assignment_answered")).toHaveLength(1);
  });

  it("tells the giver again after the thread is handed over again and answered again", async () => {
    const world = await seedNote();
    consumeOn(world, harness.instanceA);
    await ask(world, handOver(world));
    await call(world, "comment_on_canvas", { text: "Done", annotationId: world.noteId });
    await ask(world, handOver(world));
    expect((await rows("comment_assignments", world))[0]).toMatchObject({ status: "pending", notified_at: null });
    expect(await newAssignments(world.connectionId)).toEqual([member(world, world.noteId)]);
    await call(world, "comment_on_canvas", { text: "Done again", annotationId: world.noteId });
    expect(await notified(world.userId, "comment.assignment_answered")).toHaveLength(2);
  });

  it("does not answer a thread handed to another connection", async () => {
    const world = await seedNote();
    const second = await agentAccessService.createPersonalAccessToken({ userId: world.userId, name: "Codex", expiresAt: null });
    if (!second.ok) throw new Error("cap");
    await ask(world, handOver(world, second.connectionId));
    consumeOn(world, harness.instanceA);
    expect(resultOf<{ answered: boolean }>(await call(world, "comment_on_canvas", { text: "Done", annotationId: world.noteId }))).toMatchObject({ answered: false });
    expect((await rows("comment_assignments", world))[0]).toMatchObject({ status: "pending" });
    expect(await newAssignments(second.connectionId)).toEqual([member(world, world.noteId)]);
  });
});

describe("storing a Space", () => {
  it("writes no comment records, whatever its comments say", async () => {
    const world = await seedNote("editor", (userId, _ownerId, projectId) => ({
      mentions: [{ userId, projectId, mentionedAt: 1_000, label: "@Member" }],
    }));
    const name = canvasSpaceDocName(world.projectId, world.spaceId);
    const state = await readCanvas(harness.instanceA, world, (doc) => Y.encodeStateAsUpdate(doc));
    await storeDoc({ documentName: name, state });
    expect(await rows("comment_mentions", world)).toEqual([]);
    expect(await notified(world.userId, "comment.mentioned")).toEqual([]);
  });
});

describe("deleting and restoring a Space", () => {
  it("voids its records as space_deleted and empties the set, then brings both back on restore without notifying again", async () => {
    const world = await seedNote("editor", (userId, _ownerId, projectId) => ({
      mentions: [{ userId, projectId, mentionedAt: 1, label: "@m" }],
    }));
    await addSecondSpace(world);
    await ask(world, { type: "comment:mentioned", payload: { spaceId: world.spaceId, entryId: world.noteId } }, { caller: { userId: world.ownerId, role: "owner" } });
    await ask(world, handOver(world));
    expect(await spaceRpc(world, "space:delete")).toBe(true);
    expect((await rows("comment_mentions", world))[0]).toMatchObject({ void_reason: "space_deleted", deleted_at: expect.any(String) });
    expect((await rows("comment_assignments", world))[0]).toMatchObject({ void_reason: "space_deleted", deleted_at: expect.any(String) });
    expect(await newAssignments(world.connectionId)).toEqual([]);
    expect(await ask(world, handOver(world))).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await spaceRpc(world, "space:restore")).toBe(true);
    expect((await rows("comment_mentions", world))[0]).toMatchObject({ void_reason: null, deleted_at: null });
    expect((await rows("comment_assignments", world))[0]).toMatchObject({ void_reason: null, deleted_at: null, status: "pending" });
    expect(await newAssignments(world.connectionId)).toEqual([member(world, world.noteId)]);
    expect(await notified(world.userId, "comment.mentioned")).toHaveLength(1);
  });

  it("leaves a hand-over cancelled before the delete cancelled after the restore", async () => {
    const world = await seedNote();
    await addSecondSpace(world);
    await ask(world, handOver(world));
    await ask(world, { type: "comment:cancel-hand-over", payload: { spaceId: world.spaceId, threadId: world.noteId } });
    await spaceRpc(world, "space:delete");
    await spaceRpc(world, "space:restore");
    expect((await rows("comment_assignments", world))[0]).toMatchObject({ void_reason: "cancelled", deleted_at: expect.any(String) });
    expect(await newAssignments(world.connectionId)).toEqual([]);
  });
});
