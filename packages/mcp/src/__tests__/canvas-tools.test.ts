// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  commentOnCanvas,
  connectNodes,
  createCanvasNodes,
  deleteCanvasNodes,
  disconnectNodes,
  lockCanvasNodes,
  restoreNodeVersion,
  unlockCanvasNodes,
  updateCanvasNode,
} from "@mcp/tools/canvas-tools.js";
import { stubDeps } from "@mcp/__tests__/tool-deps.js";

const PROJECT = randomUUID();
const SPACE = randomUUID();
const WHERE = { projectId: PROJECT, spaceId: SPACE };

const CATALOG = {
  image: [{ name: "img-a", modality: "image", mode: ["t2i", "i2i"], params: { size: { default: "1k" } }, tier: "recommended" }],
  video: [{ name: "vid-a", modality: "video", mode: ["t2v"], params: {}, tier: "recommended" }],
  audio: [],
  tts: [],
  three_d: [],
  total: 2,
  credit_multiplier: 1,
};

describe("create_canvas_nodes", () => {
  it("sends the nodes, edges and group as one command and returns their ids", async () => {
    const result = { nodeIds: ["a", "b"], edgeIds: ["a->b"], groupId: "g" };
    const { deps, submitted } = stubDeps({ reply: () => ({ status: "done", result }) });
    const params = {
      nodes: [{ type: "image" as const, name: "Hero" }, { type: "video" as const, position: { x: 1, y: 2 } }],
      edges: [{ source: { new: 0 }, target: { new: 1 } }],
      group: { name: "Shot 1" },
    };
    expect((await createCanvasNodes.run(deps, { ...WHERE, ...params })).value).toEqual(result);
    expect(submitted.map((c) => [c.type, c.projectId, c.spaceId, c.params])).toEqual([["create_canvas_nodes", PROJECT, SPACE, params]]);
  });
});

describe("update_canvas_node", () => {
  it("sends name, position, group and text as they are", async () => {
    const { deps, submitted } = stubDeps();
    await updateCanvasNode.run(deps, { ...WHERE, nodeId: "n1", name: "New", position: { x: 3, y: 4 }, parentId: null, text: "hello" });
    expect(submitted[0]!.params).toEqual({ nodeId: "n1", name: "New", position: { x: 3, y: 4 }, parentId: null, text: "hello" });
  });

  it("switches mode and model with the model's catalog entry, and writes the prompt with its @-mentions as references", async () => {
    const { deps, submitted, calls } = stubDeps({ api: () => CATALOG });
    await updateCanvasNode.run(deps, {
      ...WHERE,
      nodeId: "n1",
      generation: {
        mode: "i2i",
        model: "img-a",
        params: { size: "2k" },
        prompt: "Paint @[Hero](h1) beside @[Dog](d1)",
        slots: { image: "h1" },
      },
    });
    expect(calls.map((c) => c.path)).toEqual(["/models"]);
    expect(submitted[0]!.params).toEqual({
      nodeId: "n1",
      generation: {
        mode: "i2i",
        model: "img-a",
        modelEntry: CATALOG.image[0],
        params: { size: "2k" },
        prompt: [{ text: "Paint " }, { ref: 0 }, { text: " beside " }, { ref: 1 }],
        mentions: ["h1", "d1"],
        slots: { image: "h1" },
      },
    });
  });

  it("numbers the mentions of the prompt, lyrics and shots in one list", async () => {
    const { deps, submitted, calls } = stubDeps();
    await updateCanvasNode.run(deps, {
      ...WHERE,
      nodeId: "n1",
      generation: { lyrics: "Sing of @[A](a)", shots: [{ duration: 3, prompt: "@[B](b) runs" }, { duration: 2, prompt: "@[A](a) stops" }] },
    });
    expect(calls).toEqual([]);
    expect(submitted[0]!.params).toEqual({
      nodeId: "n1",
      generation: {
        lyrics: [{ text: "Sing of " }, { ref: 0 }],
        shots: [
          { duration: 3, prompt: [{ ref: 1 }, { text: " runs" }] },
          { duration: 2, prompt: [{ ref: 0 }, { text: " stops" }] },
        ],
        mentions: ["a", "b"],
      },
    });
  });

  it("refuses a model the catalog does not list", async () => {
    const { deps, submitted } = stubDeps({ api: () => CATALOG });
    await expect(updateCanvasNode.run(deps, { ...WHERE, nodeId: "n1", generation: { model: "nope" } })).rejects.toMatchObject({ reason: "not_found" });
    expect(submitted).toEqual([]);
  });

  it("picks the model the panel picks for a mode change that names none: the one the node remembers for that mode", async () => {
    const remembered = { ...CATALOG, image: [...CATALOG.image, { name: "img-b", modality: "image", mode: ["i2i"], params: {}, tier: "recommended" }] };
    const node = { id: "n1", type: "image", position: { x: 0, y: 0 }, data: { handling: 0, mode: "t2i", model: "img-a", modelByMode: { i2i: "img-b" } } };
    const { deps, submitted } = stubDeps({
      api: () => remembered,
      reply: (command) => (command.type === "read_canvas" ? { status: "done", result: { nodes: [node], edges: [], people: [] } } : { status: "done", result: { nodeId: "n1" } }),
    });
    await updateCanvasNode.run(deps, { ...WHERE, nodeId: "n1", generation: { mode: "i2i" } });
    expect(submitted.map((c) => c.type)).toEqual(["read_canvas", "update_canvas_node"]);
    expect(submitted[1]!.params).toMatchObject({ generation: { mode: "i2i", model: "img-b", modelEntry: { name: "img-b" } } });
  });

  it("refuses a mode no model serves", async () => {
    const node = { id: "n1", type: "image", position: { x: 0, y: 0 }, data: { handling: 0 } };
    const { deps, submitted } = stubDeps({ api: () => CATALOG, reply: () => ({ status: "done", result: { nodes: [node], edges: [], people: [] } }) });
    await expect(updateCanvasNode.run(deps, { ...WHERE, nodeId: "n1", generation: { mode: "multi_shot" } })).rejects.toMatchObject({ reason: "invalid_request" });
    expect(submitted.map((c) => c.type)).toEqual(["read_canvas"]);
  });
});

describe("lock and unlock", () => {
  it("sends the nodes to lock or unlock", async () => {
    const { deps, submitted } = stubDeps();
    await lockCanvasNodes.run(deps, { ...WHERE, nodeIds: ["a"] });
    await unlockCanvasNodes.run(deps, { ...WHERE, nodeIds: ["b"] });
    expect(submitted.map((c) => [c.type, c.params])).toEqual([
      ["lock_canvas_nodes", { nodeIds: ["a"] }],
      ["unlock_canvas_nodes", { nodeIds: ["b"] }],
    ]);
  });
});

describe("restore_node_version", () => {
  const entry = (id: string): Record<string, unknown> => ({
    id,
    status: "success",
    content: `https://cdn/${id}.png`,
    thumbnailUrl: null,
    mediaWidth: 10,
    mediaHeight: 20,
    duration: null,
    mimeType: "image/png",
    size: 99,
    taskId: null,
  });

  it("finds the history entry, on whichever page it is, and puts it back on the node", async () => {
    const nodeId = randomUUID();
    const { deps, submitted, calls } = stubDeps({
      api: (call) => {
        const offset = Number(call.query?.offset ?? 0);
        const ids = offset === 0 ? Array.from({ length: 100 }, (_, i) => `h${String(i)}`) : ["wanted"];
        return { entries: ids.map(entry), total: 101 };
      },
    });
    await restoreNodeVersion.run(deps, { ...WHERE, nodeId, historyId: "wanted" });
    expect(calls.map((c) => c.query)).toEqual([
      { project_id: PROJECT, status: "success", limit: "100", offset: "0" },
      { project_id: PROJECT, status: "success", limit: "100", offset: "100" },
    ]);
    expect(submitted[0]!.params).toEqual({
      nodeId,
      entry: { status: "success", content: "https://cdn/wanted.png", thumbnailUrl: null, mediaWidth: 10, mediaHeight: 20, duration: null, mimeType: "image/png", size: 99 },
    });
  });

  it("refuses an entry the node's history does not hold", async () => {
    const { deps, submitted } = stubDeps({ api: () => ({ entries: [entry("other")], total: 1 }) });
    await expect(restoreNodeVersion.run(deps, { ...WHERE, nodeId: randomUUID(), historyId: "missing" })).rejects.toMatchObject({ reason: "not_found" });
    expect(submitted).toEqual([]);
  });
});

describe("comment_on_canvas", () => {
  it("sends a new note or a reply as one command", async () => {
    const { deps, submitted } = stubDeps({ reply: () => ({ status: "done", result: { replyId: "r", answered: true } }) });
    expect((await commentOnCanvas.run(deps, { ...WHERE, text: "Done", annotationId: "a1" })).value).toEqual({ replyId: "r", answered: true });
    expect(submitted[0]!.params).toEqual({ text: "Done", annotationId: "a1" });
  });
});

describe("delete_canvas_nodes", () => {
  it("deletes the nodes and reports the files no node uses any more, a hundred at a time", async () => {
    const deletedAssets = Array.from({ length: 150 }, (_, i) => ({ fileUrl: `https://cdn/${String(i)}.png`, kind: "image", nodeId: `n${String(i)}`, spaceId: SPACE }));
    const result = { deleted: ["n1"], kept: [{ nodeId: "n2", reason: "locked" }], deletedAssets };
    const { deps, calls } = stubDeps({ reply: () => ({ status: "done", result }), api: () => ({ ok: true }) });
    expect((await deleteCanvasNodes.run(deps, { ...WHERE, nodeIds: ["n1", "n2"] })).value).toEqual({ deleted: ["n1"], kept: [{ nodeId: "n2", reason: "locked" }] });
    expect(calls.map((c) => [c.path, (c.body as { entries: unknown[] }).entries.length])).toEqual([
      ["/assets/deleted", 100],
      ["/assets/deleted", 50],
    ]);
    expect((calls[0]!.body as { project_id: string; entries: unknown[] }).project_id).toBe(PROJECT);
    expect((calls[0]!.body as { entries: unknown[] }).entries[0]).toEqual({ file_url: "https://cdn/0.png", kind: "image", node_id: "n0", space_id: SPACE });
  });

  it("answers the deletion when the report fails, and logs the failure", async () => {
    const result = { deleted: ["n1"], kept: [], deletedAssets: [{ fileUrl: "https://cdn/x.png", kind: "image", nodeId: "n1", spaceId: SPACE }] };
    const { deps, reported } = stubDeps({
      reply: () => ({ status: "done", result }),
      api: () => {
        throw new Error("down");
      },
    });
    expect((await deleteCanvasNodes.run(deps, { ...WHERE, nodeIds: ["n1"] })).value).toEqual({ deleted: ["n1"], kept: [] });
    expect(reported.map((r) => r.err.message)).toEqual(["down"]);
  });
});

describe("connect and disconnect", () => {
  it("sends the edges to add or remove", async () => {
    const { deps, submitted } = stubDeps();
    await connectNodes.run(deps, { ...WHERE, edges: [{ source: "a", target: "b" }] });
    await disconnectNodes.run(deps, { ...WHERE, edgeIds: ["a->b"] });
    expect(submitted.map((c) => [c.type, c.params])).toEqual([
      ["connect_nodes", { edges: [{ source: "a", target: "b" }] }],
      ["disconnect_nodes", { edgeIds: ["a->b"] }],
    ]);
  });
});

describe("update_canvas_node input", () => {
  it("refuses an empty generation change before anything is sent", () => {
    expect(updateCanvasNode.input.safeParse({ ...WHERE, nodeId: "n1", generation: {} }).success).toBe(false);
  });
});
