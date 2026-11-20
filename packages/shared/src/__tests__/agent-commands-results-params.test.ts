// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The parameters of the first step of an external agent's composite tools
 * (breatic#1488 §6 "组合工具", §9, §10.2): before the MCP service calls the
 * server, collab places the nodes the result lands on — a model mini-tool's
 * results, the text node a reading writes, the nodes an upload fills — or
 * checks the existing node an upload goes into.
 */

import { describe, it, expect } from "vitest";

import { agentCommandParamsSchemas } from "@shared/agent-command.js";

/**
 * Whether a command type accepts these parameters.
 * @param type - The command type.
 * @param params - The parameters.
 * @returns True when they parse.
 */
function ok(type: keyof typeof agentCommandParamsSchemas, params: unknown): boolean {
  return agentCommandParamsSchemas[type].safeParse(params).success;
}

describe("result-node command parameters", () => {
  it("create_mini_tool_results names the tool, the node it runs on and the run's params", () => {
    expect(ok("create_mini_tool_results", { toolId: "image.remove-bg", sourceNodeId: "n1", params: {} })).toBe(true);
    expect(ok("create_mini_tool_results", { toolId: "image.upscale", sourceNodeId: "n1", params: { scale: "4K" } })).toBe(true);
    expect(ok("create_mini_tool_results", { toolId: "", sourceNodeId: "n1", params: {} })).toBe(false);
    expect(ok("create_mini_tool_results", { toolId: "image.upscale", params: {} })).toBe(false);
  });

  it("create_reading_node names the node and whether it is understood or transcribed", () => {
    expect(ok("create_reading_node", { sourceNodeId: "n1", reading: "understand" })).toBe(true);
    expect(ok("create_reading_node", { sourceNodeId: "n1", reading: "transcribe" })).toBe(true);
    expect(ok("create_reading_node", { sourceNodeId: "n1", reading: "summarise" })).toBe(false);
  });

  it("create_upload_nodes takes one or more files, each a node type and a name, and optionally the node they follow", () => {
    expect(ok("create_upload_nodes", { files: [{ type: "image", name: "hero.png" }] })).toBe(true);
    expect(ok("create_upload_nodes", { files: [{ type: "video", name: "a.mp4" }, { type: "text", name: "notes.txt" }], afterNodeId: "n1" })).toBe(true);
    expect(ok("create_upload_nodes", { files: [] })).toBe(false);
    expect(ok("create_upload_nodes", { files: [{ type: "group", name: "x" }] })).toBe(false);
  });

  it("check_upload_target names the node and the type of the file going into it", () => {
    expect(ok("check_upload_target", { nodeId: "n1", type: "image" })).toBe(true);
    expect(ok("check_upload_target", { nodeId: "n1", type: "annotation" })).toBe(false);
  });
});

describe("hand-over read command parameters (#1488 §11.7)", () => {
  it("read_canvas_assignments and read_document_assignments name one or more threads", () => {
    for (const type of ["read_canvas_assignments", "read_document_assignments"] as const) {
      expect(agentCommandParamsSchemas[type].parse({ threadIds: ["t1", "t2"] })).toEqual({ threadIds: ["t1", "t2"] });
      expect(ok(type, { threadIds: [] })).toBe(false);
      expect(ok(type, {})).toBe(false);
    }
  });
});
