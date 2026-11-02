// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One tool asks the reader to let the agent read Spaces (inner#1552), and its
 * arguments are the card.
 *
 * Like `ask_user` it has no `execute`: a call is a request waiting for the
 * reader, and what they share comes back as its result in a later request.
 * What only the turn knows is checked here, when the call arrives: that each
 * id is in the Space list this turn sent the model, once, that a block range
 * names a document and node ids a canvas, and the configured caps.
 */
import { describe, it, expect } from "vitest";
import { getAgentConfig } from "@breatic/core";
import type { ChatSpace } from "@breatic/shared";

import {
  ASK_USER,
  AWAITS_READER,
  BASELINE_TOOLS,
  makeRequestSpaceContentTool,
  REQUEST_SPACE_CONTENT,
  TOOL_MAP,
} from "@domain/agent/tools/index.js";
import * as domain from "@domain/index.js";

/** The Spaces this turn listed for the model. */
const LISTED: ChatSpace[] = [
  { id: "d1", name: "Storyboard", kind: "document" },
  { id: "c1", name: "Cast", kind: "canvas" },
  { id: "t1", name: "Cut", kind: "timeline" },
  { id: "x1", name: "Model", kind: "3d" },
  { id: "d2", name: "Notes", kind: "document" },
];

/** The configured caps, read the way the tool reads them. */
const caps = getAgentConfig() as unknown as {
  space_request_max_spaces: number;
  space_request_max_node_ids: number;
  space_read_timeout_ms: number;
};

/** One turn's tool, over this turn's Space list. */
const tool = makeRequestSpaceContentTool({ spaces: LISTED });

/** The schema, in the one shape a test can call. */
type Parsing = { safeParse: (value: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } };

/**
 * Whether a tool accepts these arguments.
 * @param value - What the model would have sent.
 * @param on - The tool to ask; this turn's by default.
 * @returns True when the schema lets it through.
 */
function accepts(value: unknown, on: { inputSchema: unknown } = tool): boolean {
  return (on.inputSchema as Parsing).safeParse(value).success;
}

/**
 * What the schema says about arguments it refuses.
 * @param value - What the model would have sent.
 * @returns Every issue message, joined.
 */
function refusal(value: unknown): string {
  const parsed = (tool.inputSchema as Parsing).safeParse(value);
  return (parsed.error?.issues ?? []).map((issue) => issue.message).join("\n");
}

/**
 * A request for these Spaces.
 * @param spaces - The entries.
 * @returns The arguments.
 */
function asking(...spaces: Array<Record<string, unknown>>): Record<string, unknown> {
  return { reason: "To read the earlier scene.", spaces };
}

describe("the one name this tool has", () => {
  it("is request_space_content in the registry and in the list a chat turn is offered", () => {
    expect(REQUEST_SPACE_CONTENT).toBe("request_space_content");
    expect(Object.keys(TOOL_MAP)).toContain("request_space_content");
    expect(BASELINE_TOOLS).toContain("request_space_content");
  });

  it("is one of the tools a turn waits on the reader for, beside ask_user and nothing else", () => {
    expect(AWAITS_READER).toEqual([ASK_USER, REQUEST_SPACE_CONTENT]);
    expect(AWAITS_READER).toEqual(["ask_user", "request_space_content"]);
  });

  it("is exported with that set from the package entry the server reads", () => {
    expect((domain as Record<string, unknown>).REQUEST_SPACE_CONTENT).toBe("request_space_content");
    expect((domain as Record<string, unknown>).AWAITS_READER).toEqual(["ask_user", "request_space_content"]);
  });
});

describe("how the tool runs", () => {
  it("has no execute, so a call waits for the reader", () => {
    expect((tool as { execute?: unknown }).execute).toBeUndefined();
  });

  it("tells the model to name Spaces by the id in the list, to ask for a part with blocks or node_ids, that the user may decline, and to ask once", () => {
    expect(tool.description).toMatch(/\bid\b/);
    expect(tool.description).toContain("blocks");
    expect(tool.description).toContain("node_ids");
    expect(tool.description).toMatch(/declin/i);
    expect(tool.description).toMatch(/once/i);
  });
});

describe("the configured caps", () => {
  it("default to three Spaces, a hundred node ids and twenty seconds to read", () => {
    expect(caps.space_request_max_spaces).toBe(3);
    expect(caps.space_request_max_node_ids).toBe(100);
    expect(caps.space_read_timeout_ms).toBe(20000);
  });

  it("bound how many Spaces one call asks for", () => {
    const ids = ["d1", "c1", "t1", "x1", "d2"];
    const within = ids.slice(0, caps.space_request_max_spaces).map((id) => ({ id }));
    const over = ids.slice(0, caps.space_request_max_spaces + 1).map((id) => ({ id }));
    expect(accepts(asking(...within))).toBe(true);
    expect(accepts(asking(...over))).toBe(false);
  });

  it("bound how many node ids one canvas is asked for", () => {
    const nodeIds = (n: number): string[] => Array.from({ length: n }, (_, i) => `n${String(i)}`);
    expect(accepts(asking({ id: "c1", node_ids: nodeIds(caps.space_request_max_node_ids) }))).toBe(true);
    expect(accepts(asking({ id: "c1", node_ids: nodeIds(caps.space_request_max_node_ids + 1) }))).toBe(false);
  });
});

describe("what only this turn can check", () => {
  it("takes Spaces from this turn's list, whole or in part", () => {
    expect(accepts(asking({ id: "d1" }, { id: "c1" }))).toBe(true);
    expect(accepts(asking({ id: "d1", blocks: { from: 4, to: 9 } }))).toBe(true);
    expect(accepts(asking({ id: "c1", node_ids: ["n1", "n2"] }))).toBe(true);
  });

  it("takes a Space whose kind cannot be read, whose result will say so", () => {
    expect(accepts(asking({ id: "t1" }, { id: "x1" }))).toBe(true);
  });

  it("refuses an id that is not in this turn's list, and says which", () => {
    expect(accepts(asking({ id: "d404" }))).toBe(false);
    expect(refusal(asking({ id: "d404" }))).toContain("d404");
  });

  it("refuses the same Space asked for twice in one call, and says which", () => {
    expect(accepts(asking({ id: "d1" }, { id: "d1", blocks: { from: 2 } }))).toBe(false);
    expect(refusal(asking({ id: "d1" }, { id: "d1" }))).toContain("d1");
  });

  it("takes a block range only for a document, and node ids only for a canvas", () => {
    expect(accepts(asking({ id: "c1", blocks: { from: 1 } }))).toBe(false);
    expect(accepts(asking({ id: "t1", blocks: { from: 1 } }))).toBe(false);
    expect(accepts(asking({ id: "d1", node_ids: ["n1"] }))).toBe(false);
    expect(accepts(asking({ id: "x1", node_ids: ["n1"] }))).toBe(false);
    expect(refusal(asking({ id: "c1", blocks: { from: 1 } }))).toContain("c1");
    expect(refusal(asking({ id: "d1", node_ids: ["n1"] }))).toContain("d1");
  });

  it("is checked against the list the tool was built with, so a tool built with none takes no Space", () => {
    const bare = TOOL_MAP[REQUEST_SPACE_CONTENT]!();
    expect(accepts(asking({ id: "d1" }), bare)).toBe(false);
    const other = makeRequestSpaceContentTool({ spaces: [{ id: "d9", name: "Other", kind: "document" }] });
    expect(accepts(asking({ id: "d9" }), other)).toBe(true);
    expect(accepts(asking({ id: "d1" }), other)).toBe(false);
  });

  it("still holds the shape every request has", () => {
    expect(accepts({ spaces: [{ id: "d1" }] })).toBe(false);
    expect(accepts(asking())).toBe(false);
    expect(accepts(asking({ id: "d1", blocks: { from: 1 }, node_ids: ["n1"] }))).toBe(false);
  });
});
