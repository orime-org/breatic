// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Taking the reader's answer to a Space request (inner#1552).
 *
 * The answer is held to the request it answers, and the call is settled with
 * two things kept apart: what the card draws (`output`), a summary per Space
 * with no content, and what the model is sent (`forModel`), the full result
 * under the call's own tool name. The content is in the model's copy only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** The check the service hands the store, captured per call. */
type Check = (input: unknown) => { reason: string } | { output: unknown; forModel: unknown };

const captured = vi.hoisted(() => ({ check: null as Check | null, toolCallId: "" }));

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  answerWaitingAsk: vi.fn(async (_id: string, toolCallId: string, check: Check) => {
    captured.check = check;
    captured.toolCallId = toolCallId;
    return { kind: "answered", turnIndex: 4 };
  }),
}));
vi.mock("@server/modules/conversation/conversation.repo.js", () => ({}));
vi.mock("@server/modules/project/project.service.js", () => ({}));
vi.mock("@server/modules/project/project.repo.js", () => ({}));

const conversationService = await import("@server/modules/conversation/conversation.service.js");

/** The request the agent made. */
const REQUEST = { reason: "To read the cast list.", spaces: [{ id: "c1" }, { id: "d1", blocks: { from: 3, to: 5 } }] };

/** Every canvas reduction at zero. */
const WHOLE = {
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

/** The Spaces as the browser read them. */
const SHARED = [
  { id: "c1", name: "Cast", kind: "canvas", state: "read", content: "THE CAST LIST", total_chars: 13, detail: WHOLE },
  { id: "d1", name: "Script", kind: "document", state: "read", part: { blocks: { from: 3, to: 5 } }, content: "SCENE THREE", total_chars: 11, blocks_total: 9 },
];

/**
 * Answer, and run the check the store would run on the stored input.
 * @param answer - What the browser sent.
 * @param input - The call's stored input.
 * @returns What the check settled with, or why it refused.
 * @throws {Error} When the service handed the store no check.
 */
async function settleWith(answer: Record<string, unknown>, input: unknown): Promise<{ reason: string } | { output: unknown; forModel: unknown }> {
  const answerSpaceRequest = (conversationService as unknown as {
    answerSpaceRequest: (conversationId: string, answer: Record<string, unknown>) => Promise<unknown>;
  }).answerSpaceRequest;
  expect(typeof answerSpaceRequest).toBe("function");
  await answerSpaceRequest("conv-1", answer);
  if (captured.check === null) throw new Error("no check handed to the store");
  return captured.check(input);
}

beforeEach(() => {
  captured.check = null;
  captured.toolCallId = "";
});

describe("a shared answer", () => {
  it("is taken for the call it names", async () => {
    await settleWith({ toolCallId: "req-1", decision: "shared", spaces: SHARED }, REQUEST);
    expect(captured.toolCallId).toBe("req-1");
  });

  it("is drawn from a summary per Space, without any content", async () => {
    const settled = await settleWith({ toolCallId: "req-1", decision: "shared", spaces: SHARED }, REQUEST);
    expect(settled).toMatchObject({
      output: {
        spaces: [
          { id: "c1", name: "Cast", kind: "canvas", state: "read" },
          { id: "d1", name: "Script", kind: "document", part: { blocks: { from: 3, to: 5 } }, state: "read" },
        ],
      },
    });
    const drawn = JSON.stringify((settled as { output: unknown }).output);
    expect(drawn).not.toContain("THE CAST LIST");
    expect(drawn).not.toContain("SCENE THREE");
    expect(drawn).not.toContain("total_chars");
  });

  it("is sent to the model in full, under request_space_content", async () => {
    const settled = await settleWith({ toolCallId: "req-1", decision: "shared", spaces: SHARED }, REQUEST);
    expect((settled as { forModel: unknown }).forModel).toEqual({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "req-1", toolName: "request_space_content", output: { type: "json", value: { spaces: SHARED } } },
      ],
    });
  });

  it("keeps a Space gone from the list without a name or kind", async () => {
    const gone = [SHARED[0], { id: "d1", state: "gone", part: { blocks: { from: 3, to: 5 } } }];
    const settled = await settleWith({ toolCallId: "req-1", decision: "shared", spaces: gone }, REQUEST);
    expect((settled as { output: { spaces: unknown[] } }).output.spaces[1]).toEqual({ id: "d1", part: { blocks: { from: 3, to: 5 } }, state: "gone" });
  });
});

describe("a declined answer", () => {
  it("is drawn and sent as declined, under request_space_content", async () => {
    const settled = await settleWith({ toolCallId: "req-1", decision: "declined" }, REQUEST);
    expect(settled).toEqual({
      output: { declined: true },
      forModel: {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "req-1", toolName: "request_space_content", output: { type: "json", value: { declined: true } } }],
      },
    });
  });
});

describe("an answer that does not fit", () => {
  it("is refused when the Spaces answered are not the Spaces asked for", async () => {
    const settled = await settleWith({ toolCallId: "req-1", decision: "shared", spaces: [SHARED[0]] }, REQUEST);
    expect(settled).toEqual({ reason: expect.any(String) });
  });

  it("is refused when the call it names is a questionnaire, not a Space request", async () => {
    const questionnaire = { questions: [{ header: "Ratio", question: "Which ratio?", multiSelect: false, options: [{ label: "16:9" }] }] };
    const settled = await settleWith({ toolCallId: "ask-1", decision: "declined" }, questionnaire);
    expect(settled).toEqual({ reason: expect.any(String) });
  });
});

describe("a questionnaire answer", () => {
  it("is refused when the call it names is a Space request", async () => {
    await conversationService.answerAsk("conv-1", { toolCallId: "req-1", answers: [{ index: 0, selected: ["16:9"] }] });
    if (captured.check === null) throw new Error("no check handed to the store");
    expect(captured.check(REQUEST)).toEqual({ reason: expect.any(String) });
  });
});
