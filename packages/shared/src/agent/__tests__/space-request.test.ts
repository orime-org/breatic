// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The agent's request to read Spaces, the reader's answer to it, and the
 * structural check holding the one to the other (inner#1552).
 *
 * Shared because three places read one shape: the tool that takes the model's
 * call, the card that draws it in the browser, and the route that takes the
 * reader's answer. What only the turn can know -- whether an id is in this
 * turn's Space list, whether `blocks` names a document and `node_ids` a canvas,
 * and the configured caps on how many Spaces and node ids -- is checked by the
 * tool in domain, not here (`request-space-content-contract.test.ts`).
 * Content length is checked by the route (`assertSayable`), since this package
 * reads no config.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { z } from "zod";

import {
  chatMessageSchema,
  READ_ONLY_COLLAB_TOKEN,
  REQUEST_SHAPE_PARAMS,
  sharedSpaceSchema,
  spaceAnswerMismatch,
  spaceRequestAnswerSchema,
  spaceRequestInputSchema,
} from "@shared/index.js";

type SpaceRequestInput = z.infer<typeof spaceRequestInputSchema>;
type SpaceRequestAnswer = z.infer<typeof spaceRequestAnswerSchema>;
type SharedSpace = z.infer<typeof sharedSpaceSchema>;

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

describe("the reader's answer", () => {
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

/**
 * A request for these Spaces.
 * @param spaces - Each Space asked for.
 * @returns The request, parsed.
 */
function request(...spaces: SpaceRequestInput["spaces"]): SpaceRequestInput {
  return spaceRequestInputSchema.parse({ reason: "To read the earlier scene.", spaces });
}

/**
 * A shared answer carrying these Spaces.
 * @param spaces - Each Space as read.
 * @returns The answer.
 */
function sharing(...spaces: Array<Record<string, unknown>>): SpaceRequestAnswer {
  return { toolCallId: "r1", decision: "shared", spaces } as unknown as SpaceRequestAnswer;
}

describe("an answer held to the request it answers", () => {
  it("fits when every Space asked for is answered once, in any order", () => {
    const asked = request({ id: "d1" }, { id: "c1" });
    expect(spaceAnswerMismatch(asked, sharing(READ_CANVAS, READ_DOCUMENT))).toBeNull();
  });

  it("fits a refusal whatever was asked", () => {
    const asked = request({ id: "d1", blocks: { from: 2 } }, { id: "c1", node_ids: ["n1"] });
    expect(spaceAnswerMismatch(asked, { toolCallId: "r1", decision: "declined" } as SpaceRequestAnswer)).toBeNull();
  });

  it("does not fit when a Space asked for is missing", () => {
    expect(spaceAnswerMismatch(request({ id: "d1" }, { id: "c1" }), sharing(READ_DOCUMENT))).toEqual(expect.any(String));
  });

  it("does not fit when it answers a Space nobody asked for", () => {
    expect(spaceAnswerMismatch(request({ id: "d1" }), sharing(READ_DOCUMENT, READ_CANVAS))).toEqual(expect.any(String));
  });

  it("does not fit when it answers one Space twice", () => {
    expect(spaceAnswerMismatch(request({ id: "d1" }), sharing(READ_DOCUMENT, READ_DOCUMENT))).toEqual(expect.any(String));
  });

  it("names the part asked for: the same range, and nothing for a whole Space", () => {
    const byBlocks = request({ id: "d1", blocks: { from: 2, to: 4 } });
    expect(spaceAnswerMismatch(byBlocks, sharing({ ...READ_DOCUMENT, part: { blocks: { from: 2, to: 4 } }, blocks_total: 7 }))).toBeNull();
    expect(spaceAnswerMismatch(byBlocks, sharing({ ...READ_DOCUMENT, part: { blocks: { from: 1, to: 4 } }, blocks_total: 7 }))).toEqual(
      expect.any(String),
    );
    expect(spaceAnswerMismatch(byBlocks, sharing(READ_DOCUMENT))).toEqual(expect.any(String));
    expect(
      spaceAnswerMismatch(request({ id: "d1" }), sharing({ ...READ_DOCUMENT, part: { blocks: { from: 2, to: 4 } }, blocks_total: 7 })),
    ).toEqual(expect.any(String));
  });

  it("names the same nodes asked for", () => {
    const byNodes = request({ id: "c1", node_ids: ["n1", "n2"] });
    expect(spaceAnswerMismatch(byNodes, sharing({ ...READ_CANVAS, part: { node_ids: ["n1", "n2"] }, nodes_missing: 1 }))).toBeNull();
    expect(spaceAnswerMismatch(byNodes, sharing({ ...READ_CANVAS, part: { node_ids: ["n1"] }, nodes_missing: 0 }))).toEqual(
      expect.any(String),
    );
  });

  it("carries a block count only for a range asked for, and a missing-node count only for nodes asked for", () => {
    const byBlocks = request({ id: "d1", blocks: { from: 2 } });
    expect(spaceAnswerMismatch(byBlocks, sharing({ ...READ_DOCUMENT, part: { blocks: { from: 2 } } }))).toEqual(expect.any(String));
    expect(spaceAnswerMismatch(request({ id: "d1" }), sharing({ ...READ_DOCUMENT, blocks_total: 3 }))).toEqual(expect.any(String));
    const byNodes = request({ id: "c1", node_ids: ["n1"] });
    expect(spaceAnswerMismatch(byNodes, sharing({ ...READ_CANVAS, part: { node_ids: ["n1"] } }))).toEqual(expect.any(String));
    expect(spaceAnswerMismatch(request({ id: "c1" }), sharing({ ...READ_CANVAS, nodes_missing: 0 }))).toEqual(expect.any(String));
  });

  it("fits a Space that could not be read, with the part it was asked for and no counts", () => {
    const asked = request({ id: "d1", blocks: { from: 2 } }, { id: "c1", node_ids: ["n1"] }, { id: "t1" });
    expect(
      spaceAnswerMismatch(
        asked,
        sharing(
          { id: "d1", state: "gone", part: { blocks: { from: 2 } } },
          { id: "c1", name: "Cast", kind: "canvas", state: "timed_out", part: { node_ids: ["n1"] } },
          { id: "t1", name: "Cut", kind: "timeline", state: "unreadable" },
        ),
      ),
    ).toBeNull();
  });

  it("does not hold the content to any length, which the route checks against config", () => {
    const long = { ...READ_DOCUMENT, content: "x".repeat(2_000_000), total_chars: 2_000_000 };
    expect(spaceAnswerMismatch(request({ id: "d1" }), sharing(long))).toBeNull();
  });
});

/** Ids a request may use, and ids nobody asked for. */
const ASKED_IDS = ["s1", "s2", "s3"] as const;
const STRANGER_IDS = ["x1", "x2"] as const;

/**
 * A read answer for one Space, shaped for how it was asked.
 * @param space - The request entry.
 * @returns A schema-valid read result.
 */
function readFor(space: SpaceRequestInput["spaces"][number]): SharedSpace {
  if (space.blocks !== undefined) {
    return { id: space.id, name: "N", kind: "document", state: "read", part: { blocks: space.blocks }, content: "", total_chars: 0, blocks_total: 0 } as unknown as SharedSpace;
  }
  if (space.node_ids !== undefined) {
    return {
      id: space.id,
      name: "N",
      kind: "canvas",
      state: "read",
      part: { node_ids: space.node_ids },
      content: "",
      total_chars: 0,
      detail: WHOLE_CANVAS,
      nodes_missing: 0,
    } as unknown as SharedSpace;
  }
  return { id: space.id, name: "N", kind: "document", state: "read", content: "", total_chars: 0 } as unknown as SharedSpace;
}

/** One request entry for an id: whole, by blocks or by nodes. */
const entryFor = (id: string): fc.Arbitrary<SpaceRequestInput["spaces"][number]> =>
  fc.oneof(
    fc.constant({ id }),
    fc.record({ from: fc.integer({ min: 1, max: 20 }), span: fc.integer({ min: 0, max: 20 }) }).map(({ from, span }) => ({
      id,
      blocks: { from, to: from + span },
    })),
    fc.uniqueArray(fc.constantFrom("n1", "n2", "n3"), { minLength: 1 }).map((nodeIds) => ({ id, node_ids: nodeIds })),
  );

describe("the check, over every request and every set of ids answered", () => {
  it("accepts exactly the well-formed answers whose ids are the ids asked for", () => {
    fc.assert(
      fc.property(
        fc.subarray([...ASKED_IDS], { minLength: 1 }).chain((ids) => fc.tuple(...ids.map(entryFor))),
        fc.shuffledSubarray([...ASKED_IDS, ...STRANGER_IDS]),
        (entries, answeredIds) => {
          const asked = request(...entries);
          const byId = new Map(asked.spaces.map((space) => [space.id, space]));
          const answer = sharing(...answeredIds.map((id) => readFor(byId.get(id) ?? { id }) as Record<string, unknown>));
          const askedSet = [...byId.keys()].sort();
          const fits = JSON.stringify([...answeredIds].sort()) === JSON.stringify(askedSet);
          expect(spaceAnswerMismatch(asked, answer) === null).toBe(fits);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("the token a read-only collaboration connection presents", () => {
  it("is one fixed string, not the placeholder an ordinary connection sends", () => {
    expect(typeof READ_ONLY_COLLAB_TOKEN).toBe("string");
    expect(READ_ONLY_COLLAB_TOKEN.length).toBeGreaterThan(0);
    expect(READ_ONLY_COLLAB_TOKEN).not.toBe("__cookie_auth__");
  });
});
