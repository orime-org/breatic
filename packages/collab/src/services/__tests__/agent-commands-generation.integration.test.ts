// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An external agent's generation settings (#1488 §7, §8.1, §9), executed by
 * collab with the writers the browser's generation panel and the proposal
 * landing use: a mode or model switch resolves the node's per-model records
 * against the catalog entry the MCP service read, a prompt lands as the
 * mentions a user @'ing the node's references would write, and a slot is
 * filled from a node the way a click on it fills it. Before a run, collab
 * reads out what the panel's view model is built from, so the MCP service can
 * build the same request body the browser would send.
 */

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";

import { bodyFromText } from "@breatic/shared/canvas/text-body";
import {
  addEdgeInDoc,
  addNodeInDoc,
  createEmptyNode,
  mentionedSourceIds,
  nodeDataMap,
} from "@breatic/shared/canvas-model";
import {
  call,
  canvasNodes,
  consumeOn,
  harness,
  readCanvas,
  resultOf,
  seedWorld,
  useAgentCommandHarness,
  type World,
} from "@collab/services/__tests__/agent-command-harness.js";

useAgentCommandHarness();

const HERO_URL = "https://cdn.example.com/assets/hero.png";
const STYLE_URL = "https://cdn.example.com/assets/style.png";

/** An image model's catalog entry, as `GET /api/v1/models` answers it. */
const NANO = {
  name: "nano",
  display_name: "Nano",
  modality: "image",
  mode: ["t2i", "i2i"],
  description: "",
  guide: "",
  tier: "recommended",
  generation_time: 30,
  takes_prompt: true,
  params: { aspect_ratio: { description: "Aspect ratio", values: ["1:1", "16:9"], default: "1:1" } },
  availability: { upstreams: [{ upstream: "wavespeed", weight: 1, configured: true, envVar: "WAVESPEED_API_KEY" }] },
};

interface GenerationWorld extends World {
  genId: string;
  heroId: string;
  scriptId: string;
  looseId: string;
  videoId: string;
}

/**
 * A canvas with an image node to generate on, a picture and a script wired
 * into it, an unconnected picture, and a video node.
 * @returns The world and its node ids.
 */
async function seedGeneration(): Promise<GenerationWorld> {
  const ids = { genId: randomUUID(), heroId: randomUUID(), scriptId: randomUUID(), looseId: randomUUID(), videoId: randomUUID() };
  const world = await seedWorld("owner", (canvas, uid) => {
    addNodeInDoc(canvas, { ...createEmptyNode("image", { x: 600, y: 0 }, uid), id: ids.genId });
    const hero = createEmptyNode("image", { x: 0, y: 0 }, uid);
    addNodeInDoc(canvas, { ...hero, id: ids.heroId, data: { ...hero.data, name: "Hero", content: HERO_URL } });
    const script = createEmptyNode("text", { x: 0, y: 400 }, uid);
    addNodeInDoc(canvas, { ...script, id: ids.scriptId, data: { ...script.data, name: "Script" } });
    nodeDataMap(canvas, ids.scriptId)!.set("body", bodyFromText("a quiet harbour at dawn"));
    const loose = createEmptyNode("image", { x: 0, y: 800 }, uid);
    addNodeInDoc(canvas, { ...loose, id: ids.looseId, data: { ...loose.data, name: "Loose", content: STYLE_URL } });
    addNodeInDoc(canvas, { ...createEmptyNode("video", { x: 1200, y: 0 }, uid), id: ids.videoId });
    addEdgeInDoc(canvas, { id: `${ids.heroId}->${ids.genId}`, source: ids.heroId, target: ids.genId });
    addEdgeInDoc(canvas, { id: `${ids.scriptId}->${ids.genId}`, source: ids.scriptId, target: ids.genId });
  });
  return { ...world, ...ids };
}

/**
 * One node's data as the second instance serves it.
 * @param world - Whose canvas.
 * @param nodeId - The node.
 * @returns Its data.
 */
async function dataOf(world: World, nodeId: string): Promise<Record<string, unknown>> {
  return ((await canvasNodes(harness.instanceB, world)).find((n) => n.id === nodeId)?.data ?? {}) as Record<string, unknown>;
}

describe("update_canvas_node generation", () => {
  it("switches mode and model, filing the model's own defaults under it", async () => {
    const world = await seedGeneration();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "update_canvas_node", { nodeId: world.genId, generation: { mode: "i2i", model: "nano", modelEntry: NANO } })).toMatchObject({ status: "done" });
    await expect.poll(() => dataOf(world, world.genId)).toMatchObject({
      mode: "i2i",
      model: "nano",
      modelByMode: { i2i: "nano" },
      paramsByModel: { nano: { aspect_ratio: "1:1" } },
    });
  });

  it("sets params on the model in use, keeping its other values", async () => {
    const world = await seedGeneration();
    consumeOn(world, harness.instanceA);
    await call(world, "update_canvas_node", { nodeId: world.genId, generation: { mode: "i2i", model: "nano", modelEntry: NANO } });
    expect(await call(world, "update_canvas_node", { nodeId: world.genId, generation: { params: { aspect_ratio: "16:9" } } })).toMatchObject({ status: "done" });
    await expect.poll(async () => (await dataOf(world, world.genId)).paramsByModel).toEqual({ nano: { aspect_ratio: "16:9" } });
  });

  it("refuses params on a node with no model picked yet as invalid_command", async () => {
    const world = await seedGeneration();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "update_canvas_node", { nodeId: world.genId, generation: { params: { aspect_ratio: "16:9" } } })).toMatchObject({
      status: "rejected",
      reason: "invalid_command",
    });
  });

  it("writes the prompt into the node's mode with its references @'d, and read_canvas shows it", async () => {
    const world = await seedGeneration();
    consumeOn(world, harness.instanceA);
    const reply = await call(world, "update_canvas_node", {
      nodeId: world.genId,
      generation: {
        mode: "i2i",
        model: "nano",
        modelEntry: NANO,
        prompt: [{ text: "Make " }, { ref: 0 }, { text: " brighter, in the mood of " }, { ref: 1 }],
        mentions: [world.heroId, world.scriptId],
      },
    });
    expect(reply).toMatchObject({ status: "done" });
    const mentioned = await readCanvas(harness.instanceB, world, (doc) => {
      const prompts = nodeDataMap(doc, world.genId)?.get("prompts");
      const fragment = prompts instanceof Y.Map ? prompts.get("i2i") : undefined;
      return fragment instanceof Y.XmlFragment ? mentionedSourceIds(fragment) : null;
    });
    expect(mentioned).toEqual([world.heroId, world.scriptId]);
    const read = resultOf<{ nodes: Array<{ id: string; prompts?: Record<string, string> }> }>(await call(world, "read_canvas", { nodeIds: [world.genId] }));
    // The space after the last mention is the one the editor keeps there.
    expect(read.nodes[0]!.prompts?.i2i).toBe(`Make @[Hero](${world.heroId}) brighter, in the mood of @[Script](${world.scriptId}) `);
  });

  it("refuses an @ of a node that is not connected in as a reference, and writes nothing", async () => {
    const world = await seedGeneration();
    consumeOn(world, harness.instanceA);
    await call(world, "update_canvas_node", { nodeId: world.genId, generation: { mode: "i2i", model: "nano", modelEntry: NANO } });
    expect(
      await call(world, "update_canvas_node", { nodeId: world.genId, generation: { prompt: [{ text: "Like " }, { ref: 0 }], mentions: [world.looseId] } }),
    ).toMatchObject({ status: "rejected", reason: "not_a_reference" });
    const read = resultOf<{ nodes: Array<{ prompts?: Record<string, string> }> }>(await call(world, "read_canvas", { nodeIds: [world.genId] }));
    expect(read.nodes[0]!.prompts?.i2i ?? "").toBe("");
  });

  it("fills a slot from a node, a many-file slot from several, and empties one with null", async () => {
    const world = await seedGeneration();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "update_canvas_node", { nodeId: world.videoId, generation: { slots: { firstFrameUrl: world.heroId } } })).toMatchObject({ status: "done" });
    await expect.poll(async () => (await dataOf(world, world.videoId)).firstFrameUrl).toBe(HERO_URL);
    expect(await call(world, "update_canvas_node", { nodeId: world.genId, generation: { slots: { styleImageUrls: [world.heroId, world.looseId] } } })).toMatchObject({ status: "done" });
    await expect.poll(async () => (await dataOf(world, world.genId)).styleImageUrls).toEqual([HERO_URL, STYLE_URL]);
    expect(await call(world, "update_canvas_node", { nodeId: world.videoId, generation: { slots: { firstFrameUrl: null } } })).toMatchObject({ status: "done" });
    await expect.poll(async () => (await dataOf(world, world.videoId)).firstFrameUrl ?? null).toBeNull();
  });

  it("refuses a slot the node's type does not have as invalid_command", async () => {
    const world = await seedGeneration();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "update_canvas_node", { nodeId: world.genId, generation: { slots: { firstFrameUrl: world.heroId } } })).toMatchObject({
      status: "rejected",
      reason: "invalid_command",
    });
  });

  it("refuses to change the settings of a locked node", async () => {
    const world = await seedGeneration();
    await readCanvas(harness.instanceA, world, (doc) => nodeDataMap(doc, world.genId)!.set("locked", true));
    consumeOn(world, harness.instanceA);
    expect(await call(world, "update_canvas_node", { nodeId: world.genId, generation: { mode: "i2i", model: "nano", modelEntry: NANO } })).toMatchObject({
      status: "rejected",
      reason: "locked",
    });
  });
});

describe("lyrics and storyboard shots", () => {
  const SONG = { ...NANO, name: "song", display_name: "Song", modality: "audio", mode: ["t2m"], params: {} };
  const SHOTS = { ...NANO, name: "shots", display_name: "Shots", modality: "video", mode: ["multi_shot"], params: {} };

  it("writes lyrics into the audio mode's lyrics box, and read_canvas and read_generation_inputs show them", async () => {
    const world = await seedGeneration();
    const audioId = randomUUID();
    await readCanvas(harness.instanceA, world, (doc) => addNodeInDoc(doc, { ...createEmptyNode("audio", { x: 1800, y: 0 }, world.userId), id: audioId }));
    consumeOn(world, harness.instanceA);
    expect(
      await call(world, "update_canvas_node", { nodeId: audioId, generation: { mode: "t2m", model: "song", modelEntry: SONG, lyrics: [{ text: "Morning tide, carry me home" }] } }),
    ).toMatchObject({ status: "done" });
    const read = resultOf<{ nodes: Array<{ lyrics?: Record<string, string> }> }>(await call(world, "read_canvas", { nodeIds: [audioId] }));
    expect(read.nodes[0]!.lyrics?.t2m).toBe("Morning tide, carry me home");
    const inputs = resultOf<{ lyrics: Record<string, Array<{ pieces: unknown[] }>> }>(await call(world, "read_generation_inputs", { nodeId: audioId }));
    expect(inputs.lyrics.t2m).toEqual([{ pieces: [{ text: "Morning tide, carry me home" }] }]);
  });

  it("replaces a video node's shots with the ones given, each with its seconds and prompt", async () => {
    const world = await seedGeneration();
    await readCanvas(harness.instanceA, world, (doc) => addEdgeInDoc(doc, { id: `${world.heroId}->${world.videoId}`, source: world.heroId, target: world.videoId }));
    consumeOn(world, harness.instanceA);
    expect(
      await call(world, "update_canvas_node", {
        nodeId: world.videoId,
        generation: {
          mode: "multi_shot",
          model: "shots",
          modelEntry: SHOTS,
          shots: [
            { duration: 3, prompt: [{ text: "Wide shot of the harbour" }] },
            { duration: 2, prompt: [{ text: "Close on " }, { ref: 0 }] },
          ],
          mentions: [world.heroId],
        },
      }),
    ).toMatchObject({ status: "done" });
    const read = resultOf<{ nodes: Array<{ shots?: Array<{ duration: number; prompt: string }> }> }>(await call(world, "read_canvas", { nodeIds: [world.videoId] }));
    expect(read.nodes[0]!.shots).toEqual([
      { duration: 3, prompt: "Wide shot of the harbour" },
      { duration: 2, prompt: `Close on @[Hero](${world.heroId}) ` },
    ]);
    const inputs = resultOf<{ shots: Array<{ duration: number; prompt: Array<{ pieces: unknown[] }> }> }>(await call(world, "read_generation_inputs", { nodeId: world.videoId }));
    expect(inputs.shots.map((s) => s.duration)).toEqual([3, 2]);
    expect(inputs.shots[1]!.prompt).toEqual([{ pieces: [{ text: "Close on " }, { mention: { sourceNodeId: world.heroId, kind: "image" } }, { text: " " }] }]);
  });
});

describe("read_generation_inputs", () => {
  it("reads the node, its references, their edges, the text a text reference holds, and the prompt as pieces", async () => {
    const world = await seedGeneration();
    consumeOn(world, harness.instanceA);
    await call(world, "update_canvas_node", {
      nodeId: world.genId,
      generation: { mode: "i2i", model: "nano", modelEntry: NANO, prompt: [{ text: "Make " }, { ref: 0 }], mentions: [world.heroId] },
    });
    const inputs = resultOf<{
      nodes: Array<{ id: string }>;
      edges: Array<{ source: string; target: string }>;
      textById: Record<string, string>;
      prompts: Record<string, Array<{ pieces: unknown[] }>>;
    }>(await call(world, "read_generation_inputs", { nodeId: world.genId }));
    expect(inputs.nodes.map((n) => n.id).sort()).toEqual([world.genId, world.heroId, world.scriptId].sort());
    expect(inputs.edges.map((e) => [e.source, e.target]).sort()).toEqual(
      [
        [world.heroId, world.genId],
        [world.scriptId, world.genId],
      ].sort(),
    );
    expect(inputs.textById).toEqual({ [world.scriptId]: "a quiet harbour at dawn" });
    expect(inputs.prompts.i2i).toEqual([{ pieces: [{ text: "Make " }, { mention: { sourceNodeId: world.heroId, kind: "image" } }, { text: " " }] }]);
  });

  it("answers not_found for a node that is not on the canvas", async () => {
    const world = await seedGeneration();
    consumeOn(world, harness.instanceA);
    expect(await call(world, "read_generation_inputs", { nodeId: randomUUID() })).toMatchObject({ status: "rejected", reason: "not_found" });
  });
});
