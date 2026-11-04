// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The structural check holding the reader's answer to the request to read
 * Spaces it answers (inner#1552). Content length is checked by the route.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { spaceRequestInputSchema, type SharedSpace, type SpaceRequestAnswer, type SpaceRequestInput } from "@breatic/shared";

import { spaceAnswerMismatch } from "@server/modules/conversation/space-answer-mismatch.js";

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
    expect(spaceAnswerMismatch(asked, { toolCallId: "r1", decision: "declined" })).toBeNull();
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
