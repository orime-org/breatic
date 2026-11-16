// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The parameters an external agent's generation settings travel in
 * (breatic#1488 §8.1, §9): `update_canvas_node` takes a `generation` change
 * (mode and model with the catalog entry the MCP service read, params for the
 * model in use, a prompt written as segments whose refs index `mentions`, and
 * slot picks by field naming the nodes that fill them), and
 * `read_generation_inputs` names one node.
 */

import { describe, it, expect } from "vitest";

import { AGENT_COMMAND_REFUSALS, agentCommandParamsSchemas } from "@shared/agent-command.js";

/**
 * Whether a command type accepts these parameters.
 * @param type - The command type.
 * @param params - The parameters.
 * @returns True when they parse.
 */
function ok(type: keyof typeof agentCommandParamsSchemas, params: unknown): boolean {
  return agentCommandParamsSchemas[type].safeParse(params).success;
}

const ENTRY = { name: "nano", display_name: "Nano", modality: "image", mode: "t2i", params: {} };

describe("generation refusal reasons", () => {
  it("adds the one a prompt can meet: an @ of a node that is not connected in as a reference", () => {
    expect(AGENT_COMMAND_REFUSALS).toEqual(expect.arrayContaining(["not_a_reference"]));
  });
});

describe("update_canvas_node generation", () => {
  it("takes a mode or a model only with the model's catalog entry", () => {
    expect(ok("update_canvas_node", { nodeId: "n1", generation: { mode: "t2i", model: "nano", modelEntry: ENTRY } })).toBe(true);
    expect(ok("update_canvas_node", { nodeId: "n1", generation: { model: "nano", modelEntry: ENTRY } })).toBe(true);
    expect(ok("update_canvas_node", { nodeId: "n1", generation: { model: "nano" } })).toBe(false);
    expect(ok("update_canvas_node", { nodeId: "n1", generation: { mode: "t2i" } })).toBe(false);
  });

  it("takes params, a prompt with its mentions, and slot picks on their own", () => {
    expect(ok("update_canvas_node", { nodeId: "n1", generation: { params: { aspect_ratio: "16:9" } } })).toBe(true);
    expect(ok("update_canvas_node", { nodeId: "n1", generation: { prompt: [{ text: "Make " }, { ref: 0 }], mentions: ["img-1"] } })).toBe(true);
    // A slot is filled from a node, as a click on that node fills it in the browser.
    expect(ok("update_canvas_node", { nodeId: "n1", generation: { slots: { firstFrameUrl: "img-1", styleImageUrls: ["img-2", "img-3"], endFrameUrl: null } } })).toBe(true);
  });

  it("takes lyrics and storyboard shots, whose refs index the same mentions", () => {
    expect(ok("update_canvas_node", { nodeId: "n1", generation: { lyrics: [{ text: "La la" }, { ref: 0 }], mentions: ["txt-1"] } })).toBe(true);
    expect(ok("update_canvas_node", { nodeId: "n1", generation: { shots: [{ duration: 3, prompt: [{ text: "Wide" }] }, { duration: 2, prompt: [{ ref: 0 }] }], mentions: ["img-1"] } })).toBe(true);
    expect(ok("update_canvas_node", { nodeId: "n1", generation: { shots: [{ duration: 0, prompt: [] }] } })).toBe(false);
    expect(ok("update_canvas_node", { nodeId: "n1", generation: { shots: [{ duration: 2, prompt: [{ ref: 0 }] }] } })).toBe(false);
  });

  it("refuses a prompt ref that indexes past its mentions, and an empty change", () => {
    expect(ok("update_canvas_node", { nodeId: "n1", generation: { prompt: [{ ref: 1 }], mentions: ["img-1"] } })).toBe(false);
    expect(ok("update_canvas_node", { nodeId: "n1", generation: {} })).toBe(false);
  });
});

describe("read_generation_inputs", () => {
  it("names the node whose generation is about to run", () => {
    expect(ok("read_generation_inputs", { nodeId: "n1" })).toBe(true);
    expect(ok("read_generation_inputs", {})).toBe(false);
  });
});
