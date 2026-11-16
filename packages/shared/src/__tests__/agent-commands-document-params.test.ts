// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The parameters of the document commands an external agent sends
 * (breatic#1488 §7, §11): blocks arrive as BlockNote block JSON (the MCP
 * service converts Markdown), text edits name a block and the words to
 * replace, and comments start on a block or answer a thread.
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

const PARAGRAPH = { type: "paragraph", content: [{ type: "text", text: "Hello", styles: { bold: true } }] };

describe("document refusal reasons", () => {
  it("adds the two a document write can meet: an ambiguous edit and a document format this build does not write", () => {
    expect(AGENT_COMMAND_REFUSALS).toEqual(expect.arrayContaining(["ambiguous_text", "schema_mismatch"]));
  });
});

describe("document command parameters", () => {
  it("read_document takes nothing", () => {
    expect(ok("read_document", {})).toBe(true);
  });

  it("insert_document_blocks takes blocks and, optionally, the block they follow", () => {
    expect(ok("insert_document_blocks", { blocks: [PARAGRAPH] })).toBe(true);
    expect(ok("insert_document_blocks", { afterBlockId: "b1", blocks: [PARAGRAPH, { type: "heading", props: { level: 2 }, content: "Title" }] })).toBe(true);
    expect(ok("insert_document_blocks", { afterBlockId: null, blocks: [PARAGRAPH] })).toBe(true);
    expect(ok("insert_document_blocks", { blocks: [] })).toBe(false);
    expect(ok("insert_document_blocks", { blocks: [{ content: "no type" }] })).toBe(false);
  });

  it("edit_document_text names a block, non-empty words to find, and their replacement", () => {
    expect(ok("edit_document_text", { blockId: "b1", find: "world", replace: "there" })).toBe(true);
    expect(ok("edit_document_text", { blockId: "b1", find: "world", replace: "" })).toBe(true);
    expect(ok("edit_document_text", { blockId: "b1", find: "", replace: "x" })).toBe(false);
    expect(ok("edit_document_text", { find: "world", replace: "there" })).toBe(false);
  });

  it("delete_document_blocks takes at least one block id", () => {
    expect(ok("delete_document_blocks", { blockIds: ["b1"] })).toBe(true);
    expect(ok("delete_document_blocks", { blockIds: [] })).toBe(false);
  });

  it("comment_on_document starts a thread on a block, or on words in it, or replies to a thread", () => {
    expect(ok("comment_on_document", { blockId: "b1", text: "Tighten this" })).toBe(true);
    expect(ok("comment_on_document", { blockId: "b1", find: "world", text: "Which world?" })).toBe(true);
    expect(ok("comment_on_document", { threadId: "t1", text: "Done" })).toBe(true);
    expect(ok("comment_on_document", { threadId: "t1", blockId: "b1", text: "Both" })).toBe(false);
    expect(ok("comment_on_document", { text: "Where?" })).toBe(false);
    expect(ok("comment_on_document", { threadId: "t1", text: "" })).toBe(false);
  });
});
