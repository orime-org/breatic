// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The first step of an external agent's composite tools (#1488 §6, §9,
 * §10.2): collab places the nodes a result lands on before the MCP service
 * calls the server, the way the browser places them before it sends the
 * request — a model mini-tool's results a step right of the node it runs on
 * and wired from it with the tool's id, the text node an understanding or a
 * transcription writes, and the nodes an upload fills, a batch of two or
 * more framed in a group. An upload into an existing node is checked first.
 */

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { callScopedId } from "@breatic/shared";
import { NODE_STEP, addNodeInDoc, createEmptyNode, createGroupNode } from "@breatic/shared/canvas-model";
import {
  call,
  canvasEdges,
  canvasNodes,
  consumeOn,
  harness,
  nameOf,
  replyOf,
  seedWorld,
  send,
  useAgentCommandHarness,
  type World,
} from "@collab/services/__tests__/agent-command-harness.js";

useAgentCommandHarness();

const PICTURE = "https://cdn.example.com/assets/hero.png";
const SONG = "https://cdn.example.com/assets/song.mp3";

interface ResultWorld extends World {
  imageId: string;
  audioId: string;
  emptyImageId: string;
}

/**
 * A canvas holding a picture, a song and an empty image node.
 * @returns The world and its node ids.
 */
async function seedResults(): Promise<ResultWorld> {
  const ids = { imageId: randomUUID(), audioId: randomUUID(), emptyImageId: randomUUID() };
  const world = await seedWorld("owner", (canvas, uid) => {
    const image = createEmptyNode("image", { x: 400, y: 100 }, uid);
    addNodeInDoc(canvas, { ...image, id: ids.imageId, data: { ...image.data, name: "Hero", content: PICTURE } });
    const audio = createEmptyNode("audio", { x: 400, y: 700 }, uid);
    addNodeInDoc(canvas, { ...audio, id: ids.audioId, data: { ...audio.data, name: "Song", content: SONG } });
    addNodeInDoc(canvas, { ...createEmptyNode("image", { x: 400, y: 1300 }, uid), id: ids.emptyImageId });
  });
  return { ...world, ...ids };
}

describe("create_mini_tool_results", () => {
  it("places a model tool's result a step right of the node, named after it and wired from it with the tool's id", async () => {
    const world = await seedResults();
    consumeOn(world, harness.instanceA);
    const command = await send(world, "create_mini_tool_results", { toolId: "image.remove-bg", sourceNodeId: world.imageId, params: {} });
    const resultId = callScopedId(command.callId, "result:0");
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "done", result: { nodeIds: [resultId] } });
    const result = (await canvasNodes(harness.instanceB, world)).find((n) => n.id === resultId)!;
    expect({ type: result.type, name: nameOf(result), position: result.position }).toEqual({
      type: "image",
      name: "NOBG-Hero",
      position: { x: 400 + NODE_STEP.x, y: 100 },
    });
    const edge = (await canvasEdges(harness.instanceB, world)).find((e) => e.target === resultId);
    expect(edge).toMatchObject({ id: `${world.imageId}->${resultId}`, source: world.imageId, toolId: "image.remove-bg" });
  });

  it("places every result of a tool that makes two, each wired from the node", async () => {
    const world = await seedResults();
    consumeOn(world, harness.instanceA);
    const command = await send(world, "create_mini_tool_results", { toolId: "audio.separate", sourceNodeId: world.audioId, params: {} });
    const ids = [callScopedId(command.callId, "result:0"), callScopedId(command.callId, "result:1")];
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "done", result: { nodeIds: ids } });
    const nodes = await canvasNodes(harness.instanceB, world);
    const results = ids.map((id) => nodes.find((n) => n.id === id)!);
    expect(results.map((n) => nameOf(n))).toEqual(["VOCALS-Song", "INSTRUMENTAL-Song"]);
    expect(results[0]!.position.x).toBe(400 + NODE_STEP.x);
    expect(results[1]!.position.y).toBeGreaterThan(results[0]!.position.y);
    const edges = await canvasEdges(harness.instanceB, world);
    expect(ids.every((id) => edges.some((e) => e.source === world.audioId && e.target === id && e.toolId === "audio.separate"))).toBe(true);
  });

  it("places the result right of a node inside a group by where the node is on the canvas", async () => {
    const groupId = randomUUID();
    const memberId = randomUUID();
    const world = await seedWorld("owner", (canvas, uid) => {
      addNodeInDoc(canvas, createGroupNode(groupId, { x: 1000, y: 2000 }, 600, 400, uid));
      const member = createEmptyNode("image", { x: 40, y: 60 }, uid);
      addNodeInDoc(canvas, { ...member, id: memberId, parentId: groupId, data: { ...member.data, name: "Inside", content: PICTURE } });
    });
    consumeOn(world, harness.instanceA);
    const command = await send(world, "create_mini_tool_results", { toolId: "image.remove-bg", sourceNodeId: memberId, params: {} });
    await replyOf(world, command.callId);
    const result = (await canvasNodes(harness.instanceB, world)).find((n) => n.id === callScopedId(command.callId, "result:0"))!;
    expect(result.position).toEqual({ x: 1040 + NODE_STEP.x, y: 2060 });
    expect(result.parentId).toBeUndefined();
  });

  it("places a call's results once, however many times it is delivered", async () => {
    const world = await seedResults();
    consumeOn(world, harness.instanceA);
    consumeOn(world, harness.instanceB);
    const command = await send(world, "create_mini_tool_results", { toolId: "image.remove-bg", sourceNodeId: world.imageId, params: {} });
    await replyOf(world, command.callId);
    await harness.mcp.xadd(`${world.prefix}:mcp:commands`, "*", "command", JSON.stringify(command));
    await new Promise((r) => setTimeout(r, 500));
    expect(await canvasNodes(harness.instanceA, world)).toHaveLength(5);
  });

  it("refuses a tool that runs on the user's machine, a tool for another kind of node, and a node that is gone", async () => {
    const world = await seedResults();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "create_mini_tool_results", { toolId: "image.grid", sourceNodeId: world.imageId, params: {} })).toMatchObject({
      status: "rejected",
      reason: "invalid_command",
    });
    expect(await call(world, "create_mini_tool_results", { toolId: "image.remove-bg", sourceNodeId: world.audioId, params: {} })).toMatchObject({
      status: "rejected",
      reason: "invalid_command",
    });
    expect(await call(world, "create_mini_tool_results", { toolId: "image.remove-bg", sourceNodeId: randomUUID(), params: {} })).toMatchObject({
      status: "rejected",
      reason: "not_found",
    });
    expect(await canvasNodes(harness.instanceB, world)).toHaveLength(4);
  });
});

describe("create_reading_node", () => {
  it("places the text node an understanding writes a step right of the node, named for it and wired from it", async () => {
    const world = await seedResults();
    consumeOn(world, harness.instanceA);
    const command = await send(world, "create_reading_node", { sourceNodeId: world.imageId, reading: "understand" });
    const textId = callScopedId(command.callId, "reading");
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "done", result: { nodeId: textId } });
    const text = (await canvasNodes(harness.instanceB, world)).find((n) => n.id === textId)!;
    expect({ type: text.type, name: nameOf(text), position: text.position }).toEqual({
      type: "text",
      name: "UNDERSTAND-Hero",
      position: { x: 400 + NODE_STEP.x, y: 100 },
    });
    expect((await canvasEdges(harness.instanceB, world)).map((e) => e.id)).toContain(`${world.imageId}->${textId}`);
  });

  it("names a transcription's text node TRANSCRIBE-", async () => {
    const world = await seedResults();
    consumeOn(world, harness.instanceA);
    const command = await send(world, "create_reading_node", { sourceNodeId: world.audioId, reading: "transcribe" });
    await replyOf(world, command.callId);
    const text = (await canvasNodes(harness.instanceB, world)).find((n) => n.id === callScopedId(command.callId, "reading"))!;
    expect(nameOf(text)).toBe("TRANSCRIBE-Song");
  });

  it("refuses to transcribe a picture and to understand a node with nothing in it", async () => {
    const world = await seedResults();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "create_reading_node", { sourceNodeId: world.imageId, reading: "transcribe" })).toMatchObject({
      status: "rejected",
      reason: "invalid_command",
    });
    expect(await call(world, "create_reading_node", { sourceNodeId: world.emptyImageId, reading: "understand" })).toMatchObject({
      status: "rejected",
      reason: "invalid_command",
    });
  });
});

describe("create_upload_nodes", () => {
  it("places one file's node after the node named, wired from it, in no group", async () => {
    const world = await seedResults();
    consumeOn(world, harness.instanceA);
    const command = await send(world, "create_upload_nodes", { files: [{ type: "image", name: "poster.png" }], afterNodeId: world.imageId });
    const nodeId = callScopedId(command.callId, "upload:0");
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "done", result: { nodeIds: [nodeId] } });
    const node = (await canvasNodes(harness.instanceB, world)).find((n) => n.id === nodeId)!;
    expect({ type: node.type, name: nameOf(node), parentId: node.parentId }).toEqual({ type: "image", name: "poster.png", parentId: undefined });
    expect(node.position.x).toBeGreaterThan(400);
    expect((await canvasEdges(harness.instanceB, world)).map((e) => e.id)).toContain(`${world.imageId}->${nodeId}`);
  });

  it("frames a batch of two or more in a group named for its count, as a dropped batch is", async () => {
    const world = await seedResults();
    consumeOn(world, harness.instanceA);
    const command = await send(world, "create_upload_nodes", {
      files: [
        { type: "image", name: "a.png" },
        { type: "video", name: "b.mp4" },
        { type: "text", name: "notes.txt" },
      ],
    });
    const ids = [0, 1, 2].map((i) => callScopedId(command.callId, `upload:${String(i)}`));
    const groupId = callScopedId(command.callId, "group");
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "done", result: { nodeIds: ids, groupId } });
    const nodes = await canvasNodes(harness.instanceB, world);
    const group = nodes.find((n) => n.id === groupId)!;
    expect({ type: group.type, name: nameOf(group) }).toEqual({ type: "group", name: "3 files" });
    expect(ids.map((id) => nodes.find((n) => n.id === id)).map((n) => [n?.type, n?.parentId])).toEqual([
      ["image", groupId],
      ["video", groupId],
      ["text", groupId],
    ]);
  });

  it("answers not_found for a node to follow that is not on the canvas", async () => {
    const world = await seedResults();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "create_upload_nodes", { files: [{ type: "image", name: "a.png" }], afterNodeId: randomUUID() })).toMatchObject({
      status: "rejected",
      reason: "not_found",
    });
  });
});

describe("check_upload_target", () => {
  it("lets a file into an empty node of its type", async () => {
    const world = await seedResults();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "check_upload_target", { nodeId: world.emptyImageId, type: "image" })).toMatchObject({ status: "done" });
  });

  it("refuses a node that already holds a file, a node of another type, and a locked node", async () => {
    const lockedId = randomUUID();
    const world = await seedResults();
    const fresh = await seedWorld("owner", (canvas, uid) => {
      const locked = createEmptyNode("image", { x: 0, y: 900 }, uid);
      addNodeInDoc(canvas, { ...locked, id: lockedId, data: { ...locked.data, locked: true } });
    });
    consumeOn(world, harness.instanceA);
    consumeOn(fresh, harness.instanceA);
    expect(await call(world, "check_upload_target", { nodeId: world.imageId, type: "image" })).toMatchObject({ status: "rejected", reason: "invalid_command" });
    expect(await call(world, "check_upload_target", { nodeId: world.audioId, type: "image" })).toMatchObject({ status: "rejected", reason: "invalid_command" });
    expect(await call(fresh, "check_upload_target", { nodeId: lockedId, type: "image" })).toMatchObject({ status: "rejected", reason: "locked" });
  });

  it("answers not_found for a node that is not on the canvas", async () => {
    const world = await seedResults();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "check_upload_target", { nodeId: randomUUID(), type: "image" })).toMatchObject({ status: "rejected", reason: "not_found" });
  });
});
