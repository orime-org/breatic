// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { loadLocales } from "@breatic/core";
import { addEdgeInDoc, addNodeInDoc, createEmptyNode, readEdges, readNodes } from "@breatic/shared/canvas-model";
import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ServerApiError } from "@mcp/server-api.js";
import { runGeneration, runMiniTool, transcribeNode, understandNode } from "@mcp/tools/generation-tools.js";
import { stubDeps, type ApiCall } from "@mcp/__tests__/tool-deps.js";

beforeAll(() => {
  loadLocales();
});

const PROJECT = randomUUID();
const SPACE = randomUUID();

/**
 * A model entry with only what the panels read.
 * @param over - Fields to set.
 * @returns The entry.
 */
function model(over: Record<string, unknown>): Record<string, unknown> {
  return { display_name: "M", description: "", guide: "", tier: "recommended", generation_time: 10, takes_prompt: true, availability: { upstreams: [] }, params: {}, ...over };
}

const CATALOG = {
  image: [model({ name: "img", modality: "image", mode: ["t2i", "i2i"] })],
  video: [model({ name: "vid", modality: "video", mode: ["t2v"], params: { duration: { description: "", default: 5, values: [5, 10] } } })],
  audio: [],
  tts: [model({ name: "speak", modality: "tts", mode: "tts", params: { voice_id: { description: "", default: null, remote_source: "voices" } } })],
  three_d: [],
  total: 2,
  credit_multiplier: 1,
};

/**
 * One node as collab reads it.
 * @param type - Its type.
 * @returns The node's view.
 */
function nodeOf(type: "image" | "audio" | "text" | "video"): ReturnType<typeof readNodes>[number] {
  const doc = new Y.Doc();
  addNodeInDoc(doc, createEmptyNode(type, { x: 0, y: 0 }, randomUUID()));
  return readNodes(doc)[0]!;
}

/**
 * Deps whose collab answers the generation read with `node` and `prompts`, and whose server answers as told.
 * @param node - The node.
 * @param prompts - Its prompts by mode, as pieces.
 * @param api - The server, past the catalog.
 * @returns The stubbed deps.
 */
function depsFor(node: ReturnType<typeof nodeOf>, prompts: Record<string, unknown>, api: (call: ApiCall) => unknown = () => ({ task_id: "task-1", status: "pending" })): ReturnType<typeof stubDeps> {
  return stubDeps({
    reply: () => ({ status: "done", result: { nodes: [node], edges: [], textById: {}, prompts, lyrics: {}, shots: [] } }),
    api: (call) => (call.path === "/models" ? CATALOG : api(call)),
  });
}

describe("run_generation", () => {
  it("reads the node, builds the task the image panel sends, starts it once and lists it for later", async () => {
    const node = nodeOf("image");
    const { deps, submitted, calls, tracked } = depsFor(node, { t2i: [{ pieces: [{ text: "a red fox" }] }] });
    const { value } = await runGeneration.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: node.id });
    expect(submitted.map((c) => [c.type, c.params])).toEqual([["read_generation_inputs", { nodeId: node.id }]]);
    const post = calls.find((c) => c.path === "/canvas/tasks")!;
    expect(post.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body).toMatchObject({
      task_type: "image",
      model: "img",
      project_id: PROJECT,
      space_id: SPACE,
      target_node_id: node.id,
      mode: "overwrite",
      params: { prompt: "a red fox" },
    });
    expect(value).toEqual({ taskId: "task-1", nodeId: node.id });
    expect(tracked).toEqual([{ taskId: "task-1", tool: "run_generation" }]);
  });

  it("refuses an empty prompt with the panel's words and starts nothing", async () => {
    const node = nodeOf("image");
    const { deps, calls } = depsFor(node, { t2i: [] });
    const err = (await runGeneration.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: node.id }).catch((e: unknown) => e)) as { reason: string; message: string };
    expect(err.reason).toBe("prompt-missing");
    expect(err.message).not.toMatch(/^canvas\./);
    expect(calls.some((c) => c.path === "/canvas/tasks")).toBe(false);
  });

  it("refuses a node that does not generate", async () => {
    const node = nodeOf("text");
    const { deps } = depsFor(node, {});
    await expect(runGeneration.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: node.id })).rejects.toMatchObject({ reason: "invalid_request" });
  });

  it("speaks with the first voice of the model's list when nobody picked one, as the audio panel does", async () => {
    const node = nodeOf("audio");
    const { deps, calls } = depsFor(node, { tts: [{ pieces: [{ text: "Hello" }] }] }, (call) =>
      call.path === "/models/speak/voices" ? { voices: [{ id: "v-first", name: "Ava" }], hasMore: false } : { task_id: "task-2", status: "pending" },
    );
    await runGeneration.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: node.id });
    const post = calls.find((c) => c.path === "/canvas/tasks")!;
    expect(post.body).toMatchObject({ task_type: "tts", model: "speak", params: { voice_id: "v-first", prompt: "Hello" } });
  });

  it("passes on the server's refusal, such as too few credits", async () => {
    const node = nodeOf("image");
    const { deps, tracked } = depsFor(node, { t2i: [{ pieces: [{ text: "x" }] }] }, () => {
      throw new ServerApiError(402, "Insufficient credits");
    });
    await expect(runGeneration.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: node.id })).rejects.toMatchObject({ status: 402 });
    expect(tracked).toEqual([]);
  });
});

describe("run_generation with a text reference", () => {
  it("writes an @-mentioned text node's words into the prompt", async () => {
    const doc = new Y.Doc();
    const image = createEmptyNode("image", { x: 0, y: 0 }, randomUUID());
    const text = createEmptyNode("text", { x: -400, y: 0 }, randomUUID());
    addNodeInDoc(doc, image);
    addNodeInDoc(doc, text);
    addEdgeInDoc(doc, { id: `${text.id}->${image.id}`, source: text.id, target: image.id });
    const prompts = { t2i: [{ pieces: [{ text: "Paint " }, { mention: { sourceNodeId: text.id, kind: "text" } }] }] };
    const { deps, calls } = stubDeps({
      reply: () => ({ status: "done", result: { nodes: readNodes(doc), edges: readEdges(doc), textById: { [text.id]: "a lighthouse at dusk" }, prompts, lyrics: {}, shots: [] } }),
      api: (call) => (call.path === "/models" ? CATALOG : { task_id: "t", status: "pending" }),
    });
    await runGeneration.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: image.id });
    const body = calls.find((c) => c.path === "/canvas/tasks")!.body as { params: { prompt: string } };
    expect(body.params.prompt).toContain("a lighthouse at dusk");
  });
});

describe("run_generation on a video node", () => {
  it("sends the main prompt with the video model the panel would use", async () => {
    const node = nodeOf("video");
    const { deps, calls } = depsFor(node, { t2v: [{ pieces: [{ text: "waves at night" }] }] });
    await runGeneration.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: node.id });
    expect(calls.find((c) => c.path === "/canvas/tasks")!.body).toMatchObject({ task_type: "video", model: "vid", params: { prompt: "waves at night" } });
  });
});

describe("understand_node and transcribe_node", () => {
  /**
   * A media node as read_canvas reads it.
   * @param type - Its type.
   * @param data - Its media fields.
   * @returns The node.
   */
  const mediaNode = (type: string, data: Record<string, unknown>): Record<string, unknown> => ({ id: "src", type, position: { x: 0, y: 0 }, data: { handling: 0, ...data } });

  /**
   * Deps whose collab reads `node` and places a reading node.
   * @param node - The node read.
   * @returns The stubbed deps.
   */
  const readingDeps = (node: Record<string, unknown>): ReturnType<typeof stubDeps> =>
    stubDeps({
      reply: (command) => (command.type === "read_canvas" ? { status: "done", result: { nodes: [node], edges: [], people: [] } } : { status: "done", result: { nodeId: "reading-1" } }),
      api: () => ({ task_id: "task-r", status: "pending" }),
    });

  it("places the text node it writes into, then asks the server to read the file into it", async () => {
    const { deps, submitted, calls, tracked } = readingDeps(mediaNode("image", { content: "https://cdn/x.png", mimeType: "image/png" }));
    const { value } = await understandNode.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: "src", language: "zh-CN" });
    expect(submitted.map((c) => [c.type, c.params])).toEqual([
      ["read_canvas", { nodeIds: ["src"] }],
      ["create_reading_node", { sourceNodeId: "src", reading: "understand" }],
    ]);
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/canvas/understand",
        idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
        body: { project_id: PROJECT, space_id: SPACE, source_type: "image", source_url: "https://cdn/x.png", node_ids: ["reading-1"], source_mime_type: "image/png", user_locale: "zh-CN", reader_locale: "zh-CN" },
      },
    ]);
    expect(value).toEqual({ taskId: "task-r", nodeId: "reading-1" });
    expect(tracked).toEqual([{ taskId: "task-r", tool: "understand_node" }]);
  });

  it("refuses a file its model cannot read before placing anything", async () => {
    const { deps, submitted, calls } = readingDeps(mediaNode("image", { content: "https://cdn/x.tiff", mimeType: "image/tiff" }));
    await expect(understandNode.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: "src" })).rejects.toMatchObject({ reason: "unsupported_format" });
    expect(submitted.map((c) => c.type)).toEqual(["read_canvas"]);
    expect(calls).toEqual([]);
  });

  it("transcribes a video with the filler switch and no language when none is given", async () => {
    const { deps, calls } = readingDeps(mediaNode("video", { content: "https://cdn/v.mp4", mimeType: "video/mp4" }));
    await transcribeNode.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: "src", keepFillers: true });
    expect(calls[0]).toMatchObject({ path: "/canvas/transcribe", body: { source_type: "video", keep_fillers: true, source_url: "https://cdn/v.mp4" } });
    expect(calls[0]!.body).not.toHaveProperty("user_locale");
  });

  it("refuses a node with no file", async () => {
    const { deps } = readingDeps(mediaNode("image", {}));
    await expect(understandNode.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: "src" })).rejects.toMatchObject({ reason: "invalid_request" });
  });
});

describe("run_mini_tool", () => {
  const TOOL_CATALOG = {
    image: [
      model({ name: "nano-banana-2-quick-edit", modality: "image", mode: "edit", params: { resolution: { description: "", default: "1k", values: ["1k", "2k"] } } }),
      model({ name: "bria-genfill", modality: "image", mode: "edit" }),
    ],
    video: [model({ name: "seedance-2.5-talking-avatar", modality: "video", mode: "avatar", params: { resolution: { description: "", default: "720p" } } })],
    audio: [],
    tts: [],
    three_d: [],
    total: 3,
    credit_multiplier: 1,
  };
  const picture = { id: "src", type: "image", position: { x: 0, y: 0 }, data: { handling: 0, content: "https://cdn/p.png", mimeType: "image/png", width: 1200, height: 800 } };
  const voice = { id: "voice", type: "audio", position: { x: 0, y: 300 }, data: { handling: 0, content: "https://cdn/v.mp3", duration: 4 } };

  /**
   * Deps whose collab reads the canvas nodes and places the result nodes.
   * @returns The stubbed deps.
   */
  const toolDeps = (): ReturnType<typeof stubDeps> =>
    stubDeps({
      reply: (command) =>
        command.type === "read_canvas"
          ? { status: "done", result: { nodes: [picture, voice], edges: [], people: [] } }
          : { status: "done", result: { nodeIds: ["result-1"] } },
      api: (call) => (call.path === "/models" ? TOOL_CATALOG : { task_id: "task-m", status: "pending" }),
    });

  it("places the result node, then sends the panel's request for the tool", async () => {
    const { deps, submitted, calls, tracked } = toolDeps();
    const { value } = await runMiniTool.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: "src", tool: "image.quickEdit", prompt: "make it night" });
    expect(submitted.map((c) => [c.type, c.params])).toEqual([
      ["read_canvas", { nodeIds: ["src"] }],
      ["create_mini_tool_results", { toolId: "image.quickEdit", sourceNodeId: "src", params: { resolution: "2k" } }],
    ]);
    const post = calls.find((c) => c.path === "/mini-tools")!;
    expect(post.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body).toEqual({
      tool: "image.quickEdit",
      project_id: PROJECT,
      space_id: SPACE,
      node_ids: ["result-1"],
      source: { url: "https://cdn/p.png", mime_type: "image/png", width: 1200, height: 800 },
      prompt: "make it night",
      params: { resolution: "2k" },
      slots: {},
    });
    expect(value).toEqual({ taskId: "task-m", nodeIds: ["result-1"] });
    expect(tracked).toEqual([{ taskId: "task-m", tool: "run_mini_tool" }]);
  });

  it("refuses an empty prompt the tool needs before placing anything", async () => {
    const { deps, submitted } = toolDeps();
    await expect(runMiniTool.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: "src", tool: "image.quickEdit" })).rejects.toMatchObject({ reason: "promptMissing" });
    expect(submitted.map((c) => c.type)).toEqual(["read_canvas"]);
  });

  it("asks for the mask a painting tool needs, and sends it beside the source", async () => {
    const missing = toolDeps();
    await expect(runMiniTool.run(missing.deps, { projectId: PROJECT, spaceId: SPACE, nodeId: "src", tool: "image.inpaint", prompt: "a hat" })).rejects.toMatchObject({ reason: "drawingEmpty" });
    const { deps, calls } = toolDeps();
    await runMiniTool.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: "src", tool: "image.inpaint", prompt: "a hat", mask: "https://cdn/mask.png" });
    expect(calls.find((c) => c.path === "/mini-tools")!.body).toMatchObject({ drawing: { mask: "https://cdn/mask.png" } });
  });

  it("fills a slot from a node on the canvas", async () => {
    const { deps, submitted, calls } = toolDeps();
    await runMiniTool.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: "src", tool: "image.digital-human", prompt: "hello", slots: { audio: "voice" } });
    expect(submitted[0]!.params).toEqual({ nodeIds: ["src", "voice"] });
    expect(calls.find((c) => c.path === "/mini-tools")!.body).toMatchObject({ slots: { audio: { url: "https://cdn/v.mp3", duration: 4 } } });
  });

  it("leaves a tool that runs without our models to the agent", async () => {
    const { deps, submitted } = toolDeps();
    await expect(runMiniTool.run(deps, { projectId: PROJECT, spaceId: SPACE, nodeId: "src", tool: "image.crop" })).rejects.toMatchObject({ reason: "invalid_request" });
    expect(submitted).toEqual([]);
  });
});
