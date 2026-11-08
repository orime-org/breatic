// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The agent's request to read Spaces and the user's answer to it
 * (inner#1552). Whether an answer fits the request it answers is checked by
 * the server (`space-answer-mismatch.ts`).
 *
 * Shared because three places read one shape: the tool that takes the model's
 * call, the card that draws it in the browser, and the route that takes the
 * user's answer. What only the turn can know -- whether an id is in this
 * turn's Space list, whether `blocks` names a document and `node_ids` a canvas,
 * and the configured caps on how many Spaces and node ids -- is checked by the
 * tool in domain, not here (`request-space-content-contract.test.ts`).
 * Content length is checked by the route (`assertSayable`), since this package
 * reads no config.
 */
import { describe, it, expect } from "vitest";

import {
  chatMessageSchema,
  READ_ONLY_COLLAB_TOKEN,
  REQUEST_SHAPE_PARAMS,
  sharedSpaceSchema,
  spaceRequestAnswerSchema,
  spaceRequestInputSchema,
} from "@shared/index.js";

/** A canvas reduction record with nothing reduced. */
const WHOLE_CANVAS = {
  selected_total: 0,
  selected_attached: 0,
  selected_whole: 0,
  slim: false,
  texts_cut: 0,
  names_only: 0,
  edges_not_listed: 0,
  nodes_not_listed: 0,
  groups_not_listed: 0,
};

/** A whole document, read. */
const READ_DOCUMENT = {
  id: "d1",
  name: "Storyboard",
  kind: "document",
  state: "read",
  content: "<!-- b:1 -->\n# Scene 1",
  total_chars: 22,
};

/** A whole canvas, read. */
const READ_CANVAS = {
  id: "c1",
  name: "Cast",
  kind: "canvas",
  state: "read",
  content: "{\"nodes\":[]}",
  total_chars: 12,
  detail: WHOLE_CANVAS,
};

/**
 * Whether the Space-level schema takes a value.
 * @param value - One Space's read result as the browser would send it.
 * @returns True when it parses.
 */
function takesSpace(value: unknown): boolean {
  return sharedSpaceSchema.safeParse(value).success;
}

/**
 * Whether the request schema takes a value.
 * @param value - What the model would send.
 * @returns True when it parses.
 */
function takesRequest(value: unknown): boolean {
  return spaceRequestInputSchema.safeParse(value).success;
}

/**
 * Whether a field survives the Space-level schema: refused, or dropped.
 * @param value - The input carrying the field.
 * @param field - The field.
 * @returns True only when the parse succeeds and keeps the field.
 */
function keeps(value: Record<string, unknown>, field: string): boolean {
  const parsed = sharedSpaceSchema.safeParse(value);
  return parsed.success && field in (parsed.data as Record<string, unknown>);
}

describe("the request the model sends", () => {
  it("has a reason of 1 to 200 characters", () => {
    expect(takesRequest({ reason: "x", spaces: [{ id: "d1" }] })).toBe(true);
    expect(takesRequest({ reason: "x".repeat(200), spaces: [{ id: "d1" }] })).toBe(true);
    expect(takesRequest({ reason: "x".repeat(201), spaces: [{ id: "d1" }] })).toBe(false);
    expect(takesRequest({ reason: "", spaces: [{ id: "d1" }] })).toBe(false);
    expect(takesRequest({ spaces: [{ id: "d1" }] })).toBe(false);
  });

  it("names at least one Space, each by id", () => {
    expect(takesRequest({ reason: "r", spaces: [] })).toBe(false);
    expect(takesRequest({ reason: "r", spaces: [{ id: "" }] })).toBe(false);
    expect(takesRequest({ reason: "r", spaces: [{ name: "Storyboard" }] })).toBe(false);
  });

  it("takes a block range starting at 1, its end optional and never before its start", () => {
    expect(takesRequest({ reason: "r", spaces: [{ id: "d1", blocks: { from: 1 } }] })).toBe(true);
    expect(takesRequest({ reason: "r", spaces: [{ id: "d1", blocks: { from: 3, to: 3 } }] })).toBe(true);
    expect(takesRequest({ reason: "r", spaces: [{ id: "d1", blocks: { from: 3, to: 9 } }] })).toBe(true);
    expect(takesRequest({ reason: "r", spaces: [{ id: "d1", blocks: { from: 0 } }] })).toBe(false);
    expect(takesRequest({ reason: "r", spaces: [{ id: "d1", blocks: { from: 4, to: 3 } }] })).toBe(false);
    expect(takesRequest({ reason: "r", spaces: [{ id: "d1", blocks: { from: 1.5 } }] })).toBe(false);
  });

  it("takes at least one node id when it asks by node", () => {
    expect(takesRequest({ reason: "r", spaces: [{ id: "c1", node_ids: ["n1"] }] })).toBe(true);
    expect(takesRequest({ reason: "r", spaces: [{ id: "c1", node_ids: [] }] })).toBe(false);
  });

  it("asks by blocks or by nodes, never both for one Space", () => {
    expect(takesRequest({ reason: "r", spaces: [{ id: "x", blocks: { from: 1 }, node_ids: ["n1"] }] })).toBe(false);
  });
});

describe("one Space as the browser read it", () => {
  it("is one of five states", () => {
    for (const state of ["unreadable", "timed_out", "failed"]) {
      expect(takesSpace({ id: "t1", name: "Cut", kind: "timeline", state })).toBe(true);
    }
    expect(takesSpace({ id: "t1", state: "gone" })).toBe(true);
    expect(takesSpace(READ_DOCUMENT)).toBe(true);
    expect(takesSpace({ ...READ_DOCUMENT, state: "loaded" })).toBe(false);
    expect(takesSpace({ ...READ_DOCUMENT, state: "loading" })).toBe(false);
  });

  it("carries its content and its length before the cut when read", () => {
    const { content: _content, ...noContent } = READ_DOCUMENT;
    const { total_chars: _total, ...noTotal } = READ_DOCUMENT;
    expect(takesSpace(noContent)).toBe(false);
    expect(takesSpace(noTotal)).toBe(false);
    expect(takesSpace({ ...READ_DOCUMENT, total_chars: -1 })).toBe(false);
  });

  it("carries the canvas reduction record if and only if it is a canvas", () => {
    const { detail: _detail, ...canvasWithout } = READ_CANVAS;
    expect(takesSpace(READ_CANVAS)).toBe(true);
    expect(takesSpace(canvasWithout)).toBe(false);
    expect(takesSpace({ ...READ_DOCUMENT, detail: WHOLE_CANVAS })).toBe(false);
  });

  it("marks a canvas without its record as a structural refusal", () => {
    const { detail: _detail, ...canvasWithout } = READ_CANVAS;
    const parsed = sharedSpaceSchema.safeParse(canvasWithout);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.code === "custom" && issue.params?.requestShape === true)).toBe(true);
  });

  it("carries no blocks for a document, so nothing outside the open Space reaches a document proposal", () => {
    const blocks = [{ id: "b1", type: "heading", text: "Scene 1", lossy: false, partial: false }];
    expect(keeps({ ...READ_DOCUMENT, blocks }, "blocks")).toBe(false);
  });

  it("carries a block count if and only if it was asked for a range of blocks", () => {
    const part = { blocks: { from: 2, to: 4 } };
    expect(takesSpace({ ...READ_DOCUMENT, part, blocks_total: 7 })).toBe(true);
    expect(takesSpace({ ...READ_DOCUMENT, part })).toBe(false);
    expect(takesSpace({ ...READ_DOCUMENT, blocks_total: 7 })).toBe(false);
  });

  it("carries a missing-node count if and only if it was asked for nodes", () => {
    const part = { node_ids: ["n1", "n2"] };
    expect(takesSpace({ ...READ_CANVAS, part, nodes_missing: 0 })).toBe(true);
    expect(takesSpace({ ...READ_CANVAS, part })).toBe(false);
    expect(takesSpace({ ...READ_CANVAS, nodes_missing: 1 })).toBe(false);
  });

  it("carries no content unless it was read", () => {
    for (const state of ["unreadable", "timed_out", "failed", "gone"]) {
      expect(keeps({ id: "t1", name: "Cut", kind: "timeline", state, content: "words" }, "content")).toBe(false);
    }
  });

  it("names its name and kind unless it is gone, which may lack both", () => {
    for (const state of ["unreadable", "timed_out", "failed"]) {
      expect(takesSpace({ id: "t1", kind: "timeline", state })).toBe(false);
      expect(takesSpace({ id: "t1", name: "Cut", state })).toBe(false);
    }
    expect(takesSpace({ id: "d9", state: "gone" })).toBe(true);
    expect(takesSpace({ id: "d9", name: "Old", kind: "document", state: "gone" })).toBe(true);
  });

  it("keeps the part it was asked for on every state", () => {
    const part = { blocks: { from: 1, to: 2 } };
    for (const state of ["unreadable", "timed_out", "failed"]) {
      const parsed = sharedSpaceSchema.parse({ id: "d1", name: "S", kind: "document", state, part });
      expect((parsed as Record<string, unknown>).part).toEqual(part);
    }
    expect((sharedSpaceSchema.parse({ id: "d1", state: "gone", part }) as Record<string, unknown>).part).toEqual(part);
  });
});

describe("the user's answer", () => {
  it("is the Spaces shared, or a refusal, for one call", () => {
    expect(spaceRequestAnswerSchema.safeParse({ toolCallId: "r1", decision: "shared", spaces: [READ_DOCUMENT] }).success).toBe(
      true,
    );
    expect(spaceRequestAnswerSchema.safeParse({ toolCallId: "r1", decision: "declined" }).success).toBe(true);
    expect(spaceRequestAnswerSchema.safeParse({ toolCallId: "", decision: "declined" }).success).toBe(false);
    expect(spaceRequestAnswerSchema.safeParse({ toolCallId: "r1", decision: "maybe" }).success).toBe(false);
    expect(spaceRequestAnswerSchema.safeParse({ toolCallId: "r1", decision: "shared" }).success).toBe(false);
  });
});

describe("a chat request carries words, an answer, or shared Spaces: exactly one", () => {
  const base = {
    project_id: "11111111-1111-4111-8111-111111111111",
    conversation_id: "22222222-2222-4222-8222-222222222222",
  };
  const shared = { toolCallId: "r1", decision: "shared", spaces: [READ_DOCUMENT] };
  const answer = { toolCallId: "a1", answers: [{ index: 0, selected: ["16:9"] }] };

  it("takes shared Spaces with an empty message, and keeps them", () => {
    const parsed = chatMessageSchema.parse({ ...base, message: "", shared_spaces: shared });
    expect((parsed as Record<string, unknown>).shared_spaces).toEqual(shared);
    expect(chatMessageSchema.safeParse({ ...base, message: "", shared_spaces: { toolCallId: "r1", decision: "declined" } }).success).toBe(
      true,
    );
  });

  it("refuses shared Spaces beside words, as a structural refusal", () => {
    const parsed = chatMessageSchema.safeParse({ ...base, message: "hello", shared_spaces: shared });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.code === "custom" && issue.params?.requestShape === REQUEST_SHAPE_PARAMS.requestShape)).toBe(true);
  });

  it("refuses shared Spaces beside a questionnaire answer, as a structural refusal", () => {
    const parsed = chatMessageSchema.safeParse({ ...base, message: "", answer, shared_spaces: shared });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.code === "custom" && issue.params?.requestShape === REQUEST_SHAPE_PARAMS.requestShape)).toBe(true);
  });

  it("still takes words alone and an answer alone", () => {
    expect(chatMessageSchema.safeParse({ ...base, message: "hello" }).success).toBe(true);
    expect(chatMessageSchema.safeParse({ ...base, message: "", answer }).success).toBe(true);
    expect(chatMessageSchema.safeParse({ ...base, message: "" }).success).toBe(false);
  });
});

describe("the token a read-only collaboration connection presents", () => {
  it("is one fixed string, not the placeholder an ordinary connection sends", () => {
    expect(typeof READ_ONLY_COLLAB_TOKEN).toBe("string");
    expect(READ_ONLY_COLLAB_TOKEN.length).toBeGreaterThan(0);
    expect(READ_ONLY_COLLAB_TOKEN).not.toBe("__cookie_auth__");
  });
});
