// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import {
  chatAttachedChipSchema,
  chatMessageSchema,
  emailSchema,
  projectCreateSchema,
  taskCreateSchema,
} from "@shared/schemas/api.js";

const base = {
  studioId: "11111111-1111-4111-8111-111111111111",
  name: "My Project",
  slug: "my-project",
};

describe("projectCreateSchema — spaceType (B.2 create→seed plumbing)", () => {
  it("defaults spaceType to canvas when omitted", () => {
    expect(projectCreateSchema.parse(base).spaceType).toBe("canvas");
  });

  it("accepts the three known space types", () => {
    for (const type of ["canvas", "document", "timeline"] as const) {
      expect(projectCreateSchema.parse({ ...base, spaceType: type }).spaceType).toBe(
        type,
      );
    }
  });

  it("rejects an unknown space type", () => {
    expect(() => projectCreateSchema.parse({ ...base, spaceType: "3d" })).toThrow();
  });
});

describe("taskCreateSchema — source", () => {
  const task = {
    task_type: "image",
    params: {},
    project_id: "11111111-1111-4111-8111-111111111111",
    space_id: "22222222-2222-4222-8222-222222222222",
    mode: "append" as const,
  };

  // The column has one vocabulary, and a caller that names no lane falls to
  // this default rather than to the column's own — which is a word from
  // before that vocabulary existed, and would reach the feed as a row
  // nothing can render.
  it("files a caller that names no lane under the generic one", () => {
    expect(taskCreateSchema.parse(task).source).toBe("task");
  });

  it("keeps the lane a caller does name", () => {
    expect(taskCreateSchema.parse({ ...task, source: "understand" }).source).toBe(
      "understand",
    );
  });

  it("refuses a lane outside the vocabulary", () => {
    expect(() => taskCreateSchema.parse({ ...task, source: "canvas" })).toThrow();
  });
});

describe("chatAttachedChipSchema — id", () => {
  const chip = { type: "image", name: "cover.png", data_snapshot: { url: "https://cdn.example/c.png" } };

  it("refuses an id longer than any node or file id", () => {
    expect(chatAttachedChipSchema.safeParse({ ...chip, id: "x".repeat(129) }).success).toBe(false);
  });

  it("takes an id as long as a uuid", () => {
    expect(chatAttachedChipSchema.safeParse({ ...chip, id: "0".repeat(36) }).success).toBe(true);
  });
});

describe("chatMessageSchema — time_zone", () => {
  const message = {
    message: "what time is it?",
    project_id: "11111111-1111-4111-8111-111111111111",
    conversation_id: "22222222-2222-4222-8222-222222222222",
  };

  it("takes the zone the browser reports", () => {
    const parsed = chatMessageSchema.parse({ ...message, time_zone: "Asia/Shanghai" });
    expect(parsed.time_zone).toBe("Asia/Shanghai");
  });

  it("takes a message without one", () => {
    expect(chatMessageSchema.parse(message).time_zone).toBeUndefined();
  });

  it("refuses an empty zone and one longer than 64 characters", () => {
    expect(chatMessageSchema.safeParse({ ...message, time_zone: "" }).success).toBe(false);
    expect(chatMessageSchema.safeParse({ ...message, time_zone: "x".repeat(65) }).success).toBe(false);
  });
});

describe("chatMessageSchema — the reader's Spaces (inner#1413)", () => {
  const message = {
    message: "summarise this",
    project_id: "11111111-1111-4111-8111-111111111111",
    conversation_id: "22222222-2222-4222-8222-222222222222",
  };
  const space = { id: "s1", name: "Storyboard", kind: "document" as const };

  it("takes the Space list, its total and the open Space", () => {
    const parsed = chatMessageSchema.parse({
      ...message,
      spaces: [space, { id: "s2", name: "Cast", kind: "canvas" }],
      spaces_total: 2,
      current_space: { ...space, state: "loaded", content: "# Scene 1", total_chars: 9, blocks: [] },
    });
    expect(parsed.spaces).toHaveLength(2);
    expect(parsed.spaces_total).toBe(2);
    expect(parsed.current_space).toMatchObject({ state: "loaded", content: "# Scene 1", total_chars: 9 });
  });

  it("takes a message that carries none of them", () => {
    const parsed = chatMessageSchema.parse(message);
    expect(parsed.spaces).toBeUndefined();
    expect(parsed.current_space).toBeUndefined();
  });

  it("takes an open Space whose content has not loaded or cannot be read", () => {
    expect(chatMessageSchema.safeParse({ ...message, current_space: { ...space, state: "loading" } }).success).toBe(true);
    expect(
      chatMessageSchema.safeParse({ ...message, current_space: { ...space, kind: "timeline", state: "unreadable" } }).success,
    ).toBe(true);
  });

  it("refuses a kind there is no Space type for", () => {
    expect(chatMessageSchema.safeParse({ ...message, spaces: [{ ...space, kind: "board" }] }).success).toBe(false);
  });

  it("refuses a Space name longer than a Space can be named", () => {
    expect(chatMessageSchema.safeParse({ ...message, spaces: [{ ...space, name: "x".repeat(81) }] }).success).toBe(false);
  });
});

describe("chatMessageSchema — how much of an open canvas is shown (inner#1413)", () => {
  const message = {
    message: "what is on this canvas",
    project_id: "11111111-1111-4111-8111-111111111111",
    conversation_id: "22222222-2222-4222-8222-222222222222",
  };
  const canvas = { id: "s2", name: "Cast", kind: "canvas" as const, state: "loaded" as const, content: "{}", total_chars: 2 };
  const detail = {
    selected_total: 3,
    selected_attached: 1,
    selected_whole: 2,
    slim: false,
    texts_cut: 0,
    names_only: 0,
    edges_not_listed: 0,
    nodes_not_listed: 0,
    groups_not_listed: 0,
  };

  it("takes a loaded canvas with what was done to fit it", () => {
    const parsed = chatMessageSchema.parse({ ...message, current_space: { ...canvas, detail } });
    expect(parsed.current_space).toMatchObject({ detail });
  });

  it("refuses a loaded canvas that does not say what was done to fit it", () => {
    expect(chatMessageSchema.safeParse({ ...message, current_space: canvas }).success).toBe(false);
  });

  it("refuses a document that carries a canvas's fitting", () => {
    const document = { ...canvas, kind: "document" as const, blocks: [] };
    expect(chatMessageSchema.safeParse({ ...message, current_space: { ...document, detail } }).success).toBe(false);
    expect(chatMessageSchema.safeParse({ ...message, current_space: document }).success).toBe(true);
  });

  it("refuses counts that are negative or fractional", () => {
    for (const bad of [{ texts_cut: -1 }, { names_only: 1.5 }, { nodes_not_listed: -2 }]) {
      expect(chatMessageSchema.safeParse({ ...message, current_space: { ...canvas, detail: { ...detail, ...bad } } }).success).toBe(false);
    }
  });

  it("refuses more selected nodes whole or attached than were selected", () => {
    const over = { ...detail, selected_total: 2, selected_attached: 1, selected_whole: 2 };
    expect(chatMessageSchema.safeParse({ ...message, current_space: { ...canvas, detail: over } }).success).toBe(false);
  });
});

describe("chatMessageSchema — an open document's blocks (inner#1509)", () => {
  const message = {
    message: "comment on scene 2",
    project_id: "11111111-1111-4111-8111-111111111111",
    conversation_id: "22222222-2222-4222-8222-222222222222",
  };
  const document = {
    id: "s1",
    name: "Storyboard",
    kind: "document" as const,
    state: "loaded" as const,
    content: "<!-- b:1 -->\n# Scene 2\n\n<!-- b:2 -->\nShe turns.",
    total_chars: 40,
  };
  const heading = { id: "b-1", type: "heading", text: "Scene 2", lossy: false, partial: false };
  const paragraph = { id: "b-2", type: "paragraph", text: "She turns.", lossy: true, partial: false };

  it("takes a loaded document with the blocks its content shows", () => {
    const parsed = chatMessageSchema.parse({ ...message, current_space: { ...document, blocks: [heading, paragraph] } });
    expect(parsed.current_space).toMatchObject({ blocks: [heading, paragraph] });
  });

  it("refuses a loaded document without blocks", () => {
    expect(chatMessageSchema.safeParse({ ...message, current_space: document }).success).toBe(false);
  });

  it("refuses a canvas that carries blocks", () => {
    const canvas = {
      ...document,
      kind: "canvas" as const,
      content: "{}",
      detail: {
        selected_total: 0,
        selected_attached: 0,
        selected_whole: 0,
        slim: false,
        texts_cut: 0,
        names_only: 0,
        edges_not_listed: 0,
        nodes_not_listed: 0,
        groups_not_listed: 0,
      },
    };
    expect(chatMessageSchema.safeParse({ ...message, current_space: canvas }).success).toBe(true);
    expect(chatMessageSchema.safeParse({ ...message, current_space: { ...canvas, blocks: [] } }).success).toBe(false);
  });

  it("refuses a block without an id or a type", () => {
    for (const bad of [{ ...heading, id: "" }, { ...heading, type: "" }]) {
      expect(chatMessageSchema.safeParse({ ...message, current_space: { ...document, blocks: [bad] } }).success).toBe(false);
    }
  });

  it("refuses a partial block that still carries its text", () => {
    const partial = { ...paragraph, partial: true };
    expect(chatMessageSchema.safeParse({ ...message, current_space: { ...document, blocks: [partial] } }).success).toBe(false);
    expect(
      chatMessageSchema.safeParse({ ...message, current_space: { ...document, blocks: [{ ...partial, text: "" }] } }).success,
    ).toBe(true);
  });
});

describe("chatMessageSchema — an answer to a questionnaire (inner#1542)", () => {
  const base = {
    project_id: "11111111-1111-4111-8111-111111111111",
    conversation_id: "22222222-2222-4222-8222-222222222222",
  };
  const answer = { toolCallId: "call-1", answers: [{ index: 0, selected: ["16:9"] }] };

  it("carries the answer with an empty message", () => {
    const parsed = chatMessageSchema.parse({ ...base, message: "", answer });
    expect(parsed.answer).toEqual(answer);
    expect(parsed.message).toBe("");
  });

  it("is either a message or an answer, never both", () => {
    expect(chatMessageSchema.safeParse({ ...base, message: "hello", answer }).success).toBe(false);
  });

  it("still needs words when it carries no answer", () => {
    expect(chatMessageSchema.safeParse({ ...base, message: "" }).success).toBe(false);
  });

  it("refuses an answer of the wrong shape", () => {
    expect(chatMessageSchema.safeParse({ ...base, message: "", answer: { toolCallId: "" , answers: [] } }).success).toBe(false);
  });
});

// inner#1006 §6: written columns get a zod ceiling, so an over-long value is a
// validation refusal (issue code too_big) rather than a database error.

/**
 * The issue codes a refused parse reported.
 * @param result - A failed safeParse result.
 * @returns Each issue's code.
 */
function codesOf(result: { success: boolean; error?: { issues: { code: string }[] } }): string[] {
  return (result.error?.issues ?? []).map((issue) => issue.code);
}

describe("F01 emailSchema — 254 characters after normalizing", () => {
  const local = "u".repeat(64);
  /** 64 + 1 + 63 + 1 + 63 + 1 + 57 + 4 = 254 characters. */
  const at254 = `${local}@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(57)}.com`;
  const at255 = `${local}@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(58)}.com`;

  it("builds the fixtures at the lengths the case names", () => {
    expect(at254.length).toBe(254);
    expect(at255.length).toBe(255);
  });

  it("takes a 254-character address", () => {
    expect(emailSchema.safeParse(at254)).toEqual({ success: true, data: at254 });
  });

  it("measures after trimming: 256 characters with the spaces still pass", () => {
    expect(emailSchema.safeParse(` ${at254} `)).toEqual({ success: true, data: at254 });
  });

  it("refuses a 255-character address as too_big", () => {
    const result = emailSchema.safeParse(at255);
    expect(result.success).toBe(false);
    expect(codesOf(result)).toContain("too_big");
  });
});

describe("F03 projectCreateSchema — description", () => {
  it("takes 2000 characters", () => {
    expect(projectCreateSchema.safeParse({ ...base, description: "d".repeat(2000) }).success).toBe(true);
  });

  it("refuses 2001 characters as too_big", () => {
    const result = projectCreateSchema.safeParse({ ...base, description: "d".repeat(2001) });
    expect(result.success).toBe(false);
    expect(codesOf(result)).toEqual(["too_big"]);
  });
});

describe("F05 / F06 taskCreateSchema — task_type and model", () => {
  const task = {
    task_type: "image",
    params: {},
    project_id: "11111111-1111-4111-8111-111111111111",
    space_id: "22222222-2222-4222-8222-222222222222",
    mode: "append" as const,
  };

  it("F05 takes a 50-character task_type", () => {
    expect(taskCreateSchema.safeParse({ ...task, task_type: "t".repeat(50) }).success).toBe(true);
  });

  it("F05 refuses a 51-character task_type as too_big", () => {
    const result = taskCreateSchema.safeParse({ ...task, task_type: "t".repeat(51) });
    expect(result.success).toBe(false);
    expect(codesOf(result)).toEqual(["too_big"]);
  });

  it("F06 takes a 100-character model", () => {
    expect(taskCreateSchema.safeParse({ ...task, model: "m".repeat(100) }).success).toBe(true);
  });

  it("F06 refuses a 101-character model as too_big", () => {
    const result = taskCreateSchema.safeParse({ ...task, model: "m".repeat(101) });
    expect(result.success).toBe(false);
    expect(codesOf(result)).toEqual(["too_big"]);
  });
});

describe("F08 chatAttachedChipSchema — name", () => {
  const chip = { id: "chip-1", type: "text", data_snapshot: { text: "hello" } };

  it("takes a 255-character name", () => {
    expect(chatAttachedChipSchema.safeParse({ ...chip, name: "n".repeat(255) }).success).toBe(true);
  });

  it("refuses a 256-character name as too_big", () => {
    const result = chatAttachedChipSchema.safeParse({ ...chip, name: "n".repeat(256) });
    expect(result.success).toBe(false);
    expect(codesOf(result)).toEqual(["too_big"]);
  });
});
