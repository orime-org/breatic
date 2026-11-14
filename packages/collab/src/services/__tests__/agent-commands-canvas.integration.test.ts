// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The canvas commands an external agent sends (#1488 §7, §8.3), executed by
 * collab under the same rules the browser applies to a user: a node's own
 * lock freezes it, a locked group freezes its members' geometry, a running
 * task and someone else's note keep a node from being deleted, connections
 * follow `canConnect`, and a full Space takes only deletions. A write counts
 * as the user's own edit.
 */

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { sql as dsql } from "drizzle-orm";

import { getCanvasReferencePoolCap, getMcpConfig } from "@breatic/core";
import { callScopedId } from "@breatic/shared";
import { bodyToPlainText } from "@breatic/shared/canvas/text-body";
import {
  addEdgeInDoc,
  addNodeInDoc,
  createAnnotationNode,
  createEmptyNode,
  createGroupNode,
  nodeDataMap,
} from "@breatic/shared/canvas-model";
import { getCollabConfig } from "@collab/config.js";
import {
  call,
  canvasEdges,
  canvasNodes,
  consumeOn,
  harness,
  nameOf,
  readCanvas,
  run,
  seedWorld,
  send,
  replyOf,
  resultOf,
  useAgentCommandHarness,
  type World,
} from "@collab/services/__tests__/agent-command-harness.js";

useAgentCommandHarness();

const ASSET = "https://cdn.example.com/assets/hero.png";

/**
 * A node as the second instance serves it.
 * @param world - Whose canvas.
 * @param nodeId - The node.
 * @returns The node, or undefined when it is gone.
 */
async function nodeOf(world: World, nodeId: string): Promise<Awaited<ReturnType<typeof canvasNodes>>[number] | undefined> {
  return (await canvasNodes(harness.instanceB, world)).find((n) => n.id === nodeId);
}

describe("update_canvas_node", () => {
  it("moves a node", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "update_canvas_node", { nodeId: world.nodeId, position: { x: 320, y: -80 } })).toMatchObject({ status: "done" });
    await expect.poll(async () => (await nodeOf(world, world.nodeId))?.position).toEqual({ x: 320, y: -80 });
  });

  it("puts a node into a group and takes it back out", async () => {
    const groupId = randomUUID();
    const world = await seedWorld("owner", (canvas, uid) => {
      addNodeInDoc(canvas, createGroupNode(groupId, { x: -50, y: -50 }, 600, 400, uid));
    });
    consumeOn(world, harness.instanceA);
    expect(await call(world, "update_canvas_node", { nodeId: world.nodeId, parentId: groupId })).toMatchObject({ status: "done" });
    await expect.poll(async () => (await nodeOf(world, world.nodeId))?.parentId).toBe(groupId);
    expect(await call(world, "update_canvas_node", { nodeId: world.nodeId, parentId: null })).toMatchObject({ status: "done" });
    await expect.poll(async () => (await nodeOf(world, world.nodeId))?.parentId).toBeUndefined();
  });

  it("rewrites a text node's body", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "update_canvas_node", { nodeId: world.nodeId, text: "Opening line" })).toMatchObject({ status: "done" });
    const text = await readCanvas(harness.instanceB, world, (doc) => {
      const body = nodeDataMap(doc, world.nodeId)?.get("body");
      return body instanceof Y.XmlFragment ? bodyToPlainText(body) : null;
    });
    expect(text).toBe("Opening line");
  });

  it("refuses a text body on a node that holds a file", async () => {
    const imageId = randomUUID();
    const world = await seedWorld("owner", (canvas, uid) => {
      addNodeInDoc(canvas, { ...createEmptyNode("image", { x: 400, y: 0 }, uid), id: imageId });
    });
    consumeOn(world, harness.instanceA);
    expect(await call(world, "update_canvas_node", { nodeId: imageId, text: "words" })).toMatchObject({ status: "rejected", reason: "invalid_command" });
  });

  it("refuses to rename or move a locked node, and leaves it as it was", async () => {
    const world = await seedWorld("owner", (canvas, _uid, _ownerId, textId) => {
      nodeDataMap(canvas, textId)!.set("locked", true);
    });
    consumeOn(world, harness.instanceA);
    expect(await call(world, "update_canvas_node", { nodeId: world.nodeId, name: "Renamed" })).toMatchObject({ status: "rejected", reason: "locked" });
    expect(await call(world, "update_canvas_node", { nodeId: world.nodeId, position: { x: 9, y: 9 } })).toMatchObject({ status: "rejected", reason: "locked" });
    const node = await nodeOf(world, world.nodeId);
    expect(node?.position).toEqual({ x: 0, y: 0 });
    expect(node && nameOf(node)).not.toBe("Renamed");
  });

  it("refuses to move a member of a locked group but renames it", async () => {
    const groupId = randomUUID();
    const memberId = randomUUID();
    const world = await seedWorld("owner", (canvas, uid) => {
      const group = createGroupNode(groupId, { x: 500, y: 500 }, 600, 400, uid);
      addNodeInDoc(canvas, { ...group, data: { ...group.data, locked: true } });
      addNodeInDoc(canvas, { ...createEmptyNode("image", { x: 20, y: 20 }, uid), id: memberId, parentId: groupId });
    });
    consumeOn(world, harness.instanceA);
    expect(await call(world, "update_canvas_node", { nodeId: memberId, position: { x: 60, y: 60 } })).toMatchObject({ status: "rejected", reason: "locked" });
    expect(await call(world, "update_canvas_node", { nodeId: memberId, name: "Keyframe" })).toMatchObject({ status: "done" });
    await expect.poll(async () => {
      const node = await nodeOf(world, memberId);
      return node && { name: nameOf(node), position: node.position };
    }).toEqual({ name: "Keyframe", position: { x: 20, y: 20 } });
  });
});

describe("create_canvas_nodes", () => {
  it("puts a node where the agent says", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    const command = await send(world, "create_canvas_nodes", { nodes: [{ type: "image", position: { x: 1200, y: 40 } }] });
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "done" });
    expect((await nodeOf(world, callScopedId(command.callId, "node:0")))?.position).toEqual({ x: 1200, y: 40 });
  });

  it("connects new nodes to each other and to existing ones, with the ids the browser gives a connection", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    const command = await send(world, "create_canvas_nodes", {
      nodes: [{ type: "text" }, { type: "image" }],
      edges: [
        { source: { new: 0 }, target: { new: 1 } },
        { source: { id: world.nodeId }, target: { new: 1 } },
      ],
    });
    const first = callScopedId(command.callId, "node:0");
    const second = callScopedId(command.callId, "node:1");
    const edgeIds = [`${first}->${second}`, `${world.nodeId}->${second}`];
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "done", result: { nodeIds: [first, second], edgeIds } });
    const edges = await canvasEdges(harness.instanceB, world);
    expect(edges.filter((e) => edgeIds.includes(e.id)).map((e) => [e.source, e.target]).sort()).toEqual(
      [
        [first, second],
        [world.nodeId, second],
      ].sort(),
    );
  });

  it("puts the new nodes and the named existing ones into a new group", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    const command = await send(world, "create_canvas_nodes", {
      nodes: [{ type: "image" }, { type: "video" }],
      group: { name: "Shots", include: [world.nodeId] },
    });
    const groupId = callScopedId(command.callId, "group");
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "done", result: { groupId } });
    const nodes = await canvasNodes(harness.instanceB, world);
    const group = nodes.find((n) => n.id === groupId);
    expect(group && { type: group.type, name: nameOf(group) }).toEqual({ type: "group", name: "Shots" });
    const members = nodes.filter((n) => n.parentId === groupId).map((n) => n.id).sort();
    expect(members).toEqual([callScopedId(command.callId, "node:0"), callScopedId(command.callId, "node:1"), world.nodeId].sort());
  });

  it("refuses a batch with a connection canConnect forbids and writes none of it", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    const command = await send(world, "create_canvas_nodes", {
      nodes: [{ type: "audio" }, { type: "image" }],
      edges: [{ source: { new: 0 }, target: { new: 1 } }],
    });
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "rejected", reason: "cannot_connect" });
    expect(await canvasNodes(harness.instanceB, world)).toHaveLength(1);
  });

  it("writes the edges and the group of a call once, however many times it is delivered", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    consumeOn(world, harness.instanceB);
    const command = await send(world, "create_canvas_nodes", {
      nodes: [{ type: "text" }, { type: "image" }],
      edges: [{ source: { new: 0 }, target: { new: 1 } }],
      group: {},
    });
    await replyOf(world, command.callId);
    await harness.mcp.xadd(`${world.prefix}:mcp:commands`, "*", "command", JSON.stringify(command));
    await new Promise((r) => setTimeout(r, 500));
    expect(await canvasNodes(harness.instanceA, world)).toHaveLength(4);
    expect(await canvasEdges(harness.instanceA, world)).toHaveLength(1);
  });
});

describe("lock_canvas_nodes and unlock_canvas_nodes", () => {
  it("locks and unlocks nodes", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "lock_canvas_nodes", { nodeIds: [world.nodeId] })).toMatchObject({ status: "done" });
    await expect.poll(async () => ((await nodeOf(world, world.nodeId))?.data as { locked?: boolean }).locked).toBe(true);
    expect(await call(world, "unlock_canvas_nodes", { nodeIds: [world.nodeId] })).toMatchObject({ status: "done" });
    await expect.poll(async () => ((await nodeOf(world, world.nodeId))?.data as { locked?: boolean }).locked ?? false).toBe(false);
  });

  it("answers not_found for a node that is not on the canvas, and locks none of the batch", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "lock_canvas_nodes", { nodeIds: [world.nodeId, randomUUID()] })).toMatchObject({ status: "rejected", reason: "not_found" });
    expect(((await nodeOf(world, world.nodeId))?.data as { locked?: boolean }).locked ?? false).toBe(false);
  });
});

describe("delete_canvas_nodes", () => {
  it("deletes nodes with their edges and reports the files no surviving node still uses", async () => {
    const imageId = randomUUID();
    const keeperId = randomUUID();
    const world = await seedWorld("owner", (canvas, uid, _ownerId, textId) => {
      const image = createEmptyNode("image", { x: 400, y: 0 }, uid);
      addNodeInDoc(canvas, { ...image, id: imageId, data: { ...image.data, content: ASSET } });
      const keeper = createEmptyNode("image", { x: 800, y: 0 }, uid);
      addNodeInDoc(canvas, { ...keeper, id: keeperId, data: { ...keeper.data, content: "https://cdn.example.com/assets/kept.png" } });
      addEdgeInDoc(canvas, { id: randomUUID(), source: textId, target: imageId });
    });
    consumeOn(world, harness.instanceA);
    const reply = await call(world, "delete_canvas_nodes", { nodeIds: [imageId, world.nodeId] });
    expect(reply).toMatchObject({
      status: "done",
      result: { deleted: expect.arrayContaining([imageId, world.nodeId]), kept: [], deletedAssets: [{ fileUrl: ASSET, kind: "image", nodeId: imageId, spaceId: world.spaceId }] },
    });
    expect((await canvasNodes(harness.instanceB, world)).map((n) => n.id)).toEqual([keeperId]);
    expect(await canvasEdges(harness.instanceB, world)).toEqual([]);
  });

  it("deletes a group with its members", async () => {
    const groupId = randomUUID();
    const memberId = randomUUID();
    const world = await seedWorld("owner", (canvas, uid) => {
      addNodeInDoc(canvas, createGroupNode(groupId, { x: 500, y: 500 }, 600, 400, uid));
      addNodeInDoc(canvas, { ...createEmptyNode("image", { x: 20, y: 20 }, uid), id: memberId, parentId: groupId });
    });
    consumeOn(world, harness.instanceA);
    expect(await call(world, "delete_canvas_nodes", { nodeIds: [groupId] })).toMatchObject({ status: "done" });
    expect((await canvasNodes(harness.instanceB, world)).map((n) => n.id)).toEqual([world.nodeId]);
  });

  it("keeps a locked node, a node with a running task and someone else's note, says why, and deletes the rest", async () => {
    const lockedId = randomUUID();
    const runningId = randomUUID();
    let noteId = "";
    const world = await seedWorld("editor", (canvas, uid, ownerId) => {
      const locked = createEmptyNode("image", { x: 400, y: 0 }, uid);
      addNodeInDoc(canvas, { ...locked, id: lockedId, data: { ...locked.data, locked: true } });
      const running = createEmptyNode("video", { x: 800, y: 0 }, uid);
      addNodeInDoc(canvas, { ...running, id: runningId, data: { ...running.data, taskCounts: { running: 1, done: 0, failed: 0, expired: 0 } } });
      const note = createAnnotationNode({ x: 0, y: 400 }, ownerId, "Owner's note");
      noteId = note.id;
      addNodeInDoc(canvas, note);
    });
    consumeOn(world, harness.instanceA);
    const reply = await call(world, "delete_canvas_nodes", { nodeIds: [lockedId, runningId, noteId, world.nodeId] });
    expect(reply).toMatchObject({ status: "done", result: { deleted: [world.nodeId] } });
    const { kept } = resultOf<{ kept: Array<{ nodeId: string; reason: string }> }>(reply);
    expect([...kept].sort((a, b) => a.nodeId.localeCompare(b.nodeId))).toEqual(
      [
        { nodeId: lockedId, reason: "locked" },
        { nodeId: runningId, reason: "handling" },
        { nodeId: noteId, reason: "not_yours" },
      ].sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    );
    expect((await canvasNodes(harness.instanceB, world)).map((n) => n.id).sort()).toEqual([lockedId, runningId, noteId].sort());
  });

  it("lets the Project owner delete a note another member wrote", async () => {
    let noteId = "";
    const world = await seedWorld("owner", (canvas) => {
      const note = createAnnotationNode({ x: 0, y: 400 }, randomUUID(), "A member's note");
      noteId = note.id;
      addNodeInDoc(canvas, note);
    });
    consumeOn(world, harness.instanceA);
    expect(await call(world, "delete_canvas_nodes", { nodeIds: [noteId] })).toMatchObject({ status: "done", result: { deleted: [noteId], kept: [] } });
  });
});

describe("connect_nodes and disconnect_nodes", () => {
  it("connects two nodes, a locked one included, with the id the browser gives it, and disconnects them", async () => {
    const imageId = randomUUID();
    const world = await seedWorld("owner", (canvas, uid) => {
      const image = createEmptyNode("image", { x: 400, y: 0 }, uid);
      addNodeInDoc(canvas, { ...image, id: imageId, data: { ...image.data, locked: true } });
    });
    consumeOn(world, harness.instanceA);
    const edgeId = `${world.nodeId}->${imageId}`;
    expect(await call(world, "connect_nodes", { edges: [{ source: world.nodeId, target: imageId }] })).toMatchObject({ status: "done", result: { edgeIds: [edgeId] } });
    expect((await canvasEdges(harness.instanceB, world)).map((e) => [e.id, e.source, e.target])).toEqual([[edgeId, world.nodeId, imageId]]);
    expect(await call(world, "disconnect_nodes", { edgeIds: [edgeId] })).toMatchObject({ status: "done" });
    expect(await canvasEdges(harness.instanceB, world)).toEqual([]);
  });

  it("lands a second connection between the same two nodes on the first, as a second drag in the browser does", async () => {
    const imageId = randomUUID();
    const world = await seedWorld("owner", (canvas, uid) => {
      addNodeInDoc(canvas, { ...createEmptyNode("image", { x: 400, y: 0 }, uid), id: imageId });
    });
    consumeOn(world, harness.instanceA);
    expect(await call(world, "connect_nodes", { edges: [{ source: world.nodeId, target: imageId }] })).toMatchObject({ status: "done" });
    expect(await call(world, "connect_nodes", { edges: [{ source: world.nodeId, target: imageId }] })).toMatchObject({ status: "done" });
    expect(await canvasEdges(harness.instanceB, world)).toHaveLength(1);
  });

  it("refuses a connection into a node whose reference pool is at canvas_reference_pool_cap", async () => {
    const imageId = randomUUID();
    const extraId = randomUUID();
    const cap = getCanvasReferencePoolCap();
    const world = await seedWorld("owner", (canvas, uid) => {
      addNodeInDoc(canvas, { ...createEmptyNode("image", { x: 400, y: 0 }, uid), id: imageId });
      addNodeInDoc(canvas, { ...createEmptyNode("text", { x: 0, y: 900 }, uid), id: extraId });
      for (let i = 0; i < cap; i++) {
        const source = createEmptyNode("text", { x: i * 10, y: 600 }, uid);
        addNodeInDoc(canvas, source);
        addEdgeInDoc(canvas, { id: `${source.id}->${imageId}`, source: source.id, target: imageId });
      }
    });
    consumeOn(world, harness.instanceA);
    expect(await call(world, "connect_nodes", { edges: [{ source: extraId, target: imageId }] })).toMatchObject({ status: "rejected", reason: "reference_pool_full" });
    expect(await canvasEdges(harness.instanceB, world)).toHaveLength(cap);
  });

  it("refuses a connection canConnect forbids", async () => {
    const audioId = randomUUID();
    const imageId = randomUUID();
    const world = await seedWorld("owner", (canvas, uid) => {
      addNodeInDoc(canvas, { ...createEmptyNode("audio", { x: 400, y: 0 }, uid), id: audioId });
      addNodeInDoc(canvas, { ...createEmptyNode("image", { x: 800, y: 0 }, uid), id: imageId });
    });
    consumeOn(world, harness.instanceA);
    expect(await call(world, "connect_nodes", { edges: [{ source: audioId, target: imageId }] })).toMatchObject({ status: "rejected", reason: "cannot_connect" });
    expect(await canvasEdges(harness.instanceB, world)).toEqual([]);
  });

  it("answers not_found for an end that is not on the canvas", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "connect_nodes", { edges: [{ source: world.nodeId, target: randomUUID() }] })).toMatchObject({ status: "rejected", reason: "not_found" });
  });
});

describe("comment_on_canvas", () => {
  it("starts a thread at a point, written by the user", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    const command = await send(world, "comment_on_canvas", { text: "Make the opening shorter", position: { x: 50, y: 60 } });
    const annotationId = callScopedId(command.callId, "annotation");
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "done", result: { annotationId } });
    const note = await nodeOf(world, annotationId);
    expect(note).toMatchObject({ type: "annotation", position: { x: 50, y: 60 }, data: { content: "Make the opening shorter", createdBy: world.userId } });
  });

  it("starts a thread pinned on a node: the pin's tip lands inside it, near its top-left corner", async () => {
    const imageId = randomUUID();
    const world = await seedWorld("owner", (canvas, uid) => {
      addNodeInDoc(canvas, { ...createEmptyNode("image", { x: 400, y: 100 }, uid), id: imageId });
    });
    consumeOn(world, harness.instanceA);
    const command = await send(world, "comment_on_canvas", { text: "Brighter sky", nodeId: imageId });
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "done" });
    const nodes = await canvasNodes(harness.instanceB, world);
    const image = nodes.find((n) => n.id === imageId)!;
    const tip = nodes.find((n) => n.id === callScopedId(command.callId, "annotation"))!.position;
    // Every content node is larger than 100 x 100, so a tip this close to the
    // corner is on the node whatever its type's default size.
    expect(tip.x).toBeGreaterThan(image.position.x);
    expect(tip.x).toBeLessThan(image.position.x + 100);
    expect(tip.y).toBeGreaterThan(image.position.y);
    expect(tip.y).toBeLessThan(image.position.y + 100);
  });

  it("replies as the user and records which connection wrote it", async () => {
    let noteId = "";
    const world = await seedWorld("owner", (canvas, _uid, ownerId) => {
      const note = createAnnotationNode({ x: 0, y: 400 }, ownerId, "Shorter?");
      noteId = note.id;
      addNodeInDoc(canvas, note);
    });
    consumeOn(world, harness.instanceA);
    const command = await send(world, "comment_on_canvas", { text: "Cut to two sentences", annotationId: noteId });
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "done", result: { replyId: callScopedId(command.callId, "reply"), answered: false } });
    const replies = ((await nodeOf(world, noteId))?.data as { replies?: unknown[] }).replies;
    expect(replies).toEqual([
      expect.objectContaining({ id: callScopedId(command.callId, "reply"), content: "Cut to two sentences", createdBy: world.userId, via: world.connectionId }),
    ]);
  });

  it("answers a thread handed to this connection: the reply carries the hand-over time", async () => {
    let noteId = "";
    const world = await seedWorld("owner", (canvas, _uid, ownerId) => {
      const note = createAnnotationNode({ x: 0, y: 400 }, ownerId, "Shorter?");
      noteId = note.id;
      addNodeInDoc(canvas, note);
    });
    const assignedAt = 1_700_000_000_000;
    await readCanvas(harness.instanceA, world, (doc) => {
      nodeDataMap(doc, noteId)!.set("assignment", { connectionId: world.connectionId, assignedBy: world.userId, assignedAt });
    });
    consumeOn(world, harness.instanceA);
    const reply = await call(world, "comment_on_canvas", { text: "Done", annotationId: noteId });
    expect(reply).toMatchObject({ status: "done", result: { answered: true } });
    const replies = ((await nodeOf(world, noteId))?.data as { replies?: unknown[] }).replies;
    expect(replies).toEqual([expect.objectContaining({ via: world.connectionId, answers: assignedAt })]);
  });

  it("does not answer a thread handed to another connection", async () => {
    let noteId = "";
    const world = await seedWorld("owner", (canvas, uid) => {
      const note = createAnnotationNode({ x: 0, y: 400 }, uid, "Shorter?");
      noteId = note.id;
      addNodeInDoc(canvas, note);
    });
    await readCanvas(harness.instanceA, world, (doc) => {
      nodeDataMap(doc, noteId)!.set("assignment", { connectionId: randomUUID(), assignedBy: world.userId, assignedAt: 1 });
    });
    consumeOn(world, harness.instanceA);
    expect(await call(world, "comment_on_canvas", { text: "Done", annotationId: noteId })).toMatchObject({ status: "done", result: { answered: false } });
    const replies = ((await nodeOf(world, noteId))?.data as { replies?: Array<Record<string, unknown>> }).replies;
    expect(replies?.[0]).not.toHaveProperty("answers");
  });

  it("answers not_found for a reply to a note that is gone", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "comment_on_canvas", { text: "Done", annotationId: randomUUID() })).toMatchObject({ status: "rejected", reason: "not_found" });
  });
});

describe("restore_node_version", () => {
  const entry = {
    status: "success",
    content: "https://cdn.example.com/assets/v1.png",
    thumbnailUrl: null,
    mediaWidth: 1024,
    mediaHeight: 768,
    duration: null,
    mimeType: "image/png",
    size: 2048,
  };

  it("puts a history row's content and media numbers back on the node", async () => {
    const imageId = randomUUID();
    const world = await seedWorld("owner", (canvas, uid) => {
      const image = createEmptyNode("image", { x: 400, y: 0 }, uid);
      addNodeInDoc(canvas, { ...image, id: imageId, data: { ...image.data, content: ASSET } });
    });
    consumeOn(world, harness.instanceA);
    expect(await call(world, "restore_node_version", { nodeId: imageId, entry })).toMatchObject({ status: "done" });
    await expect.poll(async () => (await nodeOf(world, imageId))?.data).toMatchObject({ content: entry.content, width: 1024, height: 768, mimeType: "image/png" });
  });

  it("refuses to restore a locked node", async () => {
    const imageId = randomUUID();
    const world = await seedWorld("owner", (canvas, uid) => {
      const image = createEmptyNode("image", { x: 400, y: 0 }, uid);
      addNodeInDoc(canvas, { ...image, id: imageId, data: { ...image.data, content: ASSET, locked: true } });
    });
    consumeOn(world, harness.instanceA);
    expect(await call(world, "restore_node_version", { nodeId: imageId, entry })).toMatchObject({ status: "rejected", reason: "locked" });
    expect(((await nodeOf(world, imageId))?.data as { content?: string }).content).toBe(ASSET);
  });
});

describe("limits", () => {
  it("returns at most read_canvas_max_nodes nodes from a whole-canvas read and says how many there are", async () => {
    const max = getMcpConfig().read_canvas_max_nodes;
    const world = await seedWorld("owner", (canvas, uid) => {
      for (let i = 0; i < max; i++) addNodeInDoc(canvas, createEmptyNode("text", { x: i * 10, y: 500 }, uid));
    });
    consumeOn(world, harness.instanceA);
    const reply = await call(world, "read_canvas", {});
    expect(reply).toMatchObject({ status: "done", result: { truncated: true, total: max + 1 } });
    expect(resultOf<{ nodes: unknown[] }>(reply).nodes).toHaveLength(max);
  });

  it("on a Space past max_document_bytes takes only what removes content, as the browser's refusalOf does", async () => {
    const big = "x".repeat(getCollabConfig().max_document_bytes + 1024);
    const bigId = randomUUID();
    const lockedId = randomUUID();
    const world = await seedWorld("owner", (canvas, uid, _ownerId, textId) => {
      const node = createEmptyNode("text", { x: 400, y: 0 }, uid);
      addNodeInDoc(canvas, { ...node, id: bigId, data: { ...node.data, name: big } });
      const locked = createEmptyNode("image", { x: 800, y: 0 }, uid);
      addNodeInDoc(canvas, { ...locked, id: lockedId, data: { ...locked.data, locked: true } });
      addEdgeInDoc(canvas, { id: `${textId}->${lockedId}`, source: textId, target: lockedId });
    });
    consumeOn(world, harness.instanceA);
    expect(await call(world, "create_canvas_nodes", { nodes: [{ type: "text" }] })).toMatchObject({ status: "rejected", reason: "space_full" });
    expect(await call(world, "update_canvas_node", { nodeId: world.nodeId, name: "x" })).toMatchObject({ status: "rejected", reason: "space_full" });
    expect(await call(world, "lock_canvas_nodes", { nodeIds: [world.nodeId] })).toMatchObject({ status: "rejected", reason: "space_full" });
    expect(await call(world, "unlock_canvas_nodes", { nodeIds: [lockedId] })).toMatchObject({ status: "done" });
    expect(await call(world, "disconnect_nodes", { edgeIds: [`${world.nodeId}->${lockedId}`] })).toMatchObject({ status: "done" });
    expect(await call(world, "delete_canvas_nodes", { nodeIds: [bigId] })).toMatchObject({ status: "done", result: { deleted: [bigId] } });
  }, 60_000);
});

describe("whose edit it is", () => {
  it("records a write as the user's own edit of the Project", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "update_canvas_node", { nodeId: world.nodeId, name: "Mine" })).toMatchObject({ status: "done" });
    await expect
      .poll(async () => {
        const [row] = await run<{ n: number }>(dsql`
          SELECT count(*)::int AS n FROM account_activity_events
          WHERE user_id = ${world.userId} AND project_id = ${world.projectId} AND kind = 'project_edit'`);
        return row!.n;
      })
      .toBeGreaterThan(0);
  });

  it("records no edit for a read", async () => {
    const world = await seedWorld();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "read_canvas", {})).toMatchObject({ status: "done" });
    await new Promise((r) => setTimeout(r, 300));
    expect(
      await run<{ n: number }>(dsql`
        SELECT count(*)::int AS n FROM account_activity_events WHERE user_id = ${world.userId} AND kind = 'project_edit'`),
    ).toEqual([{ n: 0 }]);
  });
});
