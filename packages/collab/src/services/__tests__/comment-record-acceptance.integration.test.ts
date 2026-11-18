// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Comment records synced after each store (breatic#1488 §11.6, §11.7): the
 * members a canvas's annotations mention and the threads handed to an
 * external agent land in `comment_mentions` and `comment_assignments`, and
 * the notifications they call for go out once.
 */

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { sql as dsql } from "drizzle-orm";

import { env, getStreamRedis } from "@breatic/core";
import { assignmentsChangedChannel, canvasSpaceDocName, projectMetaDocName, type SpaceRpcRequest } from "@breatic/shared";
import { canvasNodesMap } from "@breatic/shared/canvas-model";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import { storeDoc } from "@collab/services/persistence.js";
import { handleSpaceRpc } from "@collab/services/space-rpc.js";
import { harness, run, seedWorld, useAgentCommandHarness, type World } from "@collab/services/__tests__/agent-command-harness.js";

useAgentCommandHarness();

/**
 * Store the world's canvas after a change, the way a timed store does.
 * @param world - Whose canvas.
 * @param change - What to change in it.
 */
async function storeCanvas(world: World, change: (canvas: Y.Doc) => void): Promise<void> {
  const name = canvasSpaceDocName(world.projectId, world.spaceId);
  const canvas = new Y.Doc();
  Y.applyUpdate(canvas, (await yjsRepo.fetchDocData(name))!);
  change(canvas);
  await storeDoc({ documentName: name, state: Y.encodeStateAsUpdate(canvas) });
}

/**
 * Put an annotation on a canvas, or change the one there.
 * @param canvas - The canvas document.
 * @param id - The annotation's id.
 * @param data - Fields to set on its data.
 */
function annotate(canvas: Y.Doc, id: string, data: Record<string, unknown>): void {
  let node = canvasNodesMap(canvas).get(id);
  if (!node) {
    node = new Y.Map<unknown>();
    canvasNodesMap(canvas).set(id, node);
    node.set("id", id);
    node.set("type", "annotation");
    const fresh = new Y.Map<unknown>();
    node.set("data", fresh);
    fresh.set("replies", new Y.Array());
  }
  const map = node.get("data") as Y.Map<unknown>;
  for (const [key, value] of Object.entries(data)) map.set(key, value);
}

/**
 * Add a reply under an annotation.
 * @param canvas - The canvas document.
 * @param id - The annotation's id.
 * @param reply - The reply's fields.
 */
function reply(canvas: Y.Doc, id: string, reply: Record<string, unknown>): void {
  const replies = (canvasNodesMap(canvas).get(id)!.get("data") as Y.Map<unknown>).get("replies") as Y.Array<Y.Map<unknown>>;
  const m = new Y.Map<unknown>();
  replies.push([m]);
  for (const [key, value] of Object.entries({ id: randomUUID(), content: "done", createdAt: Date.now(), ...reply })) m.set(key, value);
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

describe("mentions", () => {
  it("records a member a comment mentions and notifies them once, however often it is stored", async () => {
    const world = await seedWorld("editor");
    const id = randomUUID();
    const mention = { userId: world.userId, projectId: world.projectId, mentionedAt: 1_000, label: "@Member" };
    await storeCanvas(world, (c) => annotate(c, id, { content: "@Member look", createdBy: world.ownerId, mentions: [mention] }));
    await storeCanvas(world, () => undefined);
    expect(await rows("comment_mentions", world)).toEqual([
      expect.objectContaining({ entry_id: id, thread_id: id, user_id: world.userId, author_id: world.ownerId, deleted_at: null, notified_at: expect.any(String) }),
    ]);
    expect(await notified(world.userId, "comment.mentioned")).toEqual([
      { projectId: world.projectId, spaceId: world.spaceId, entryId: id, threadId: id, authorId: world.ownerId },
    ]);
  });

  it("voids a mention whose words are gone and brings it back without a second notification", async () => {
    const world = await seedWorld("editor");
    const id = randomUUID();
    const mention = { userId: world.userId, projectId: world.projectId, mentionedAt: 1_000, label: "@Member" };
    await storeCanvas(world, (c) => annotate(c, id, { createdBy: world.ownerId, mentions: [mention] }));
    await storeCanvas(world, (c) => annotate(c, id, { mentions: [] }));
    expect((await rows("comment_mentions", world))[0]).toMatchObject({ deleted_at: expect.any(String) });
    await storeCanvas(world, (c) => annotate(c, id, { mentions: [mention] }));
    expect((await rows("comment_mentions", world))[0]).toMatchObject({ deleted_at: null });
    expect(await notified(world.userId, "comment.mentioned")).toHaveLength(1);
  });

  it("does not notify someone who mentions themselves, or someone outside the project", async () => {
    const world = await seedWorld("editor");
    const [outsider] = await run<{ id: string }>(dsql`INSERT INTO users (email, email_verified) VALUES (${`out-${randomUUID()}@example.com`}, true) RETURNING id`);
    const at = { projectId: world.projectId, mentionedAt: 1, label: "@x" };
    await storeCanvas(world, (c) => annotate(c, randomUUID(), { createdBy: world.ownerId, mentions: [{ userId: world.ownerId, ...at }, { userId: outsider!.id, ...at }] }));
    expect(await rows("comment_mentions", world)).toHaveLength(2);
    expect(await notified(world.ownerId, "comment.mentioned")).toEqual([]);
    expect(await notified(outsider!.id, "comment.mentioned")).toEqual([]);
  });
});

describe("hand-overs", () => {
  it("records a hand-over as pending, then answered once its agent replies, telling the giver once per hand-over", async () => {
    const world = await seedWorld("editor");
    const id = randomUUID();
    const assignment = { connectionId: world.connectionId, assignedBy: world.userId, assignedAt: 5_000 };
    await storeCanvas(world, (c) => annotate(c, id, { createdBy: world.ownerId, assignment }));
    expect(await rows("comment_assignments", world)).toEqual([
      expect.objectContaining({ thread_id: id, connection_id: world.connectionId, assigned_by: world.userId, assigned_at: "5000", status: "pending", notified_at: null }),
    ]);
    await storeCanvas(world, (c) => reply(c, id, { createdBy: world.userId, via: world.connectionId, answers: 5_000 }));
    await storeCanvas(world, () => undefined);
    expect((await rows("comment_assignments", world))[0]).toMatchObject({ status: "answered", notified_at: expect.any(String) });
    expect(await notified(world.userId, "comment.assignment_answered")).toEqual([
      { projectId: world.projectId, spaceId: world.spaceId, threadId: id, connectionId: world.connectionId },
    ]);
    await storeCanvas(world, (c) => annotate(c, id, { assignment: { ...assignment, assignedAt: 6_000 } }));
    expect((await rows("comment_assignments", world))[0]).toMatchObject({ status: "pending", assigned_at: "6000", notified_at: null });
    await storeCanvas(world, (c) => reply(c, id, { createdBy: world.userId, via: world.connectionId, answers: 6_000 }));
    expect(await notified(world.userId, "comment.assignment_answered")).toHaveLength(2);
  });

  it("announces assignments:changed on the project's channel when a Space's hand-overs change", async () => {
    const world = await seedWorld("editor");
    const subscriber = getStreamRedis().duplicate();
    const heard: string[] = [];
    subscriber.on("message", (_channel: string, message: string) => heard.push(message));
    await subscriber.subscribe(assignmentsChangedChannel(env.REDIS_KEY_PREFIX, world.projectId));
    try {
      const assignment = { connectionId: world.connectionId, assignedBy: world.userId, assignedAt: 5_000 };
      await storeCanvas(world, (c) => annotate(c, randomUUID(), { createdBy: world.ownerId, assignment }));
      await storeCanvas(world, () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(heard.map((m) => JSON.parse(m) as unknown)).toEqual([
        expect.objectContaining({ type: "project-assignments:changed", projectId: world.projectId, spaceId: world.spaceId }),
      ]);
    } finally {
      await subscriber.quit();
    }
  });
});

describe("a Space the project no longer lists", () => {
  it("writes no records for a store that lands after the Space left the meta document", async () => {
    const world = await seedWorld("editor");
    await yjsRepo.upsertDocData(projectMetaDocName(world.projectId), Y.encodeStateAsUpdate(new Y.Doc()));
    const assignment = { connectionId: world.connectionId, assignedBy: world.userId, assignedAt: 5_000 };
    await storeCanvas(world, (c) => annotate(c, randomUUID(), { createdBy: world.ownerId, assignment }));
    expect(await rows("comment_assignments", world)).toEqual([]);
  });
});

describe("deleting and restoring a Space", () => {
  it("voids a deleted Space's records and brings them back on restore, notifying nobody again", async () => {
    const world = await seedWorld("editor");
    // A second Space, so the first one may be deleted.
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
    const id = randomUUID();
    await storeCanvas(world, (c) =>
      annotate(c, id, {
        createdBy: world.ownerId,
        mentions: [{ userId: world.userId, projectId: world.projectId, mentionedAt: 1, label: "@m" }],
        assignment: { connectionId: world.connectionId, assignedBy: world.userId, assignedAt: 5_000 },
      }),
    );
    /**
     * Ask for a Space change as the project's owner.
     * @param type - Delete or restore.
     * @returns Whether it went through.
     */
    const rpc = async (type: "space:delete" | "space:restore"): Promise<boolean> =>
      (await handleSpaceRpc({ hocuspocus: harness.instanceA }, world.projectId, { userId: world.ownerId, role: "owner" }, {
        id: randomUUID(),
        type,
        payload: { spaceId: world.spaceId },
      } as SpaceRpcRequest)).ok;
    expect(await rpc("space:delete")).toBe(true);
    expect((await rows("comment_mentions", world))[0]).toMatchObject({ deleted_at: expect.any(String) });
    expect((await rows("comment_assignments", world))[0]).toMatchObject({ deleted_at: expect.any(String) });
    expect(await rpc("space:restore")).toBe(true);
    expect((await rows("comment_mentions", world))[0]).toMatchObject({ deleted_at: null });
    expect((await rows("comment_assignments", world))[0]).toMatchObject({ deleted_at: null, status: "pending" });
    expect(await notified(world.userId, "comment.mentioned")).toHaveLength(1);
  });
});
