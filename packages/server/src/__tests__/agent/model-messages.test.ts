// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Turning stored history into what the model is given.
 *
 * Two shapes, two audiences. Storage keeps one message per turn with its
 * pieces in order, which is what a person reads. The model is given the same
 * history split the way the protocol wants it: the call on the assistant, the
 * result on a message of its own.
 *
 * Handing the stored shape straight over is what made any conversation that
 * had used a tool fail on its next turn (task #75) — a tool result is not a
 * string to the SDK, and a reply that called a tool but never spoke is not an
 * empty message, it is a message with a call in it.
 */

import { describe, it, expect } from "vitest";
import { FAILURE_LINES, NOTHING_SAID_WHY } from "@breatic/shared";
import { userTurnForModel } from "@server/agent/user-turn.js";
import type { MessageData } from "@breatic/shared";

import { toModelMessages } from "@server/agent/model-messages.js";
import { EARLIER_RESULT_NOTE } from "@server/agent/stored-model-output.js";

/**
 * The output of the one tool result in what the model is given.
 * @param history - Stored history holding a single tool use.
 * @returns The output field of the tool message.
 */
function replayedOutput(history: MessageData[]): unknown {
  const toolMessage = toModelMessages(history).find((m) => m.role === "tool");
  return (toolMessage as { content: Array<{ output: unknown }> } | undefined)?.content[0]?.output;
}

/**
 * Build a stored message the way the repository hands it out.
 * @param role - Who is speaking
 * @param parts - The pieces of the message, in order
 * @returns A message in the shape the store returns
 */
function stored(role: "user" | "assistant", parts: MessageData["parts"]): MessageData {
  const content = parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
  return { id: "m1", role, parts, content, ts: "2026-08-11T00:00:00Z", turnIndex: 1 };
}

describe("history on its way to the model", () => {
  it("splits a tool use into the call and the result the protocol expects", () => {
    const history = [
      stored("user", [{ type: "text", text: "find me references" }]),
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-1",
          toolName: "web_search",
          input: { query: "cyberpunk" },
          status: "success",
          output: "three links",
        },
        { type: "text", text: "Here is what I found." },
      ]),
    ];

    expect(toModelMessages(history)).toEqual([
      { role: "user", content: "find me references" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "web_search",
            input: { query: "cyberpunk" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "web_search",
            output: { type: "text", value: "three links" },
          },
        ],
      },
      { role: "assistant", content: "Here is what I found." },
    ]);
  });

  it("carries the result as typed output, never as a bare string", () => {
    // One stored message carrying one tool use becomes two: the call, then
    // the result.
    const [, toolMessage] = toModelMessages([
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-2",
          toolName: "web_search",
          input: { url: "https://example.com" },
          status: "success",
          output: "the page said something",
        },
      ]),
    ]);

    // The SDK validates this field against a discriminated union at runtime;
    // a string here is the exact failure this conversion exists to remove.
    const output = (toolMessage as { content: Array<{ output: unknown }> } | undefined)
      ?.content[0]?.output;
    expect(output).toEqual({ type: "text", value: "the page said something" });
    expect(typeof output).not.toBe("string");
  });

  it("says a structured result written before the model's copy was kept is no longer available", () => {
    // A row from before `forModel` existed, written by a tool that has since
    // been removed. Reading `output` with the current code is what made a
    // conversation fail every turn once a tool's answer gained a field, so a
    // structured result with no stored copy goes to the model as a note.
    const output = replayedOutput([
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-3",
          toolName: "show_search_results",
          input: { sourceQuery: "a reference" },
          status: "success",
          output: { sourceQuery: "a reference", links: [] },
        },
      ]),
    ]);

    expect(output).toEqual({ type: "text", value: EARLIER_RESULT_NOTE });
  });

  it("hands back a picture search as the model was given it when the turn ran", () => {
    // What the model read during the turn was written down with it. Handing
    // that back, and never the tool's raw answer, is what keeps the replay
    // the same text the turn read -- field names and long addresses never
    // reach the model.
    const answer = {
      query: "cyberpunk city",
      images: [
        {
          thumbnailUrl: "https://thumb.example/1.jpg",
          imageUrl: "https://i.example/1.png",
          pageUrl: "https://page.example/1",
          title: "A picture",
        },
      ],
      sent: 1,
    };
    const output = replayedOutput([
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-img",
          toolName: "search_images",
          input: { query: "cyberpunk city" },
          status: "success",
          output: answer,
          forModel: { type: "text", value: "1. A picture" },
        },
      ]),
    ]);

    expect(output).toEqual({ type: "text", value: "1. A picture" });
  });


  it("says so even for a turn stopped before it got a word out", () => {
    const history = [
      stored("user", [{ type: "text", text: "hello" }]),
      stored("assistant", [{ type: "interrupted" }]),
    ];

    // Used to be dropped whole, on the grounds that an assistant message with
    // nothing in it reaches the provider as an empty text block. The note is
    // what it has instead -- not empty, and it is the only trace the next turn
    // has that anything happened here at all.
    const [, note] = toModelMessages(history);
    expect(note).toMatchObject({ role: "assistant" });
    expect(String((note as { content: string }).content)).toMatch(/did not finish/i);
  });

  it("tells the model a turn ran out of room rather than out of things to say", () => {
    const history = [
      stored("assistant", [{ type: "text", text: "half a sen" }, { type: "truncated" }]),
    ];

    const [said, note] = toModelMessages(history);
    expect(String((said as { content: string }).content)).toBe("half a sen");
    expect(String((note as { content: string }).content)).toMatch(/output limit/i);
  });

  it("says a turn was stopped rather than cut off when it was both", () => {
    // A reader who presses stop on a turn already at the ceiling leaves both
    // marks. What the next turn needs to know is that nobody wants the rest.
    const history = [
      stored("assistant", [
        { type: "text", text: "half a sen" },
        { type: "truncated" },
        { type: "interrupted" },
      ]),
    ];

    const [, note] = toModelMessages(history);
    expect(String((note as { content: string }).content)).toMatch(/connection to the user/i);
  });

  it("keeps what a stopped turn managed to say, and marks it as cut off", () => {
    const history = [
      stored("assistant", [{ type: "text", text: "half a sen" }, { type: "interrupted" }]),
    ];

    const [said, note] = toModelMessages(history);
    expect(String((said as { content: string }).content)).toBe("half a sen");
    // The note follows what was said rather than being spliced into it: the
    // words are the model's, the note is ours.
    expect(String((note as { content: string }).content)).toMatch(/did not finish/i);
  });

  it("never sends the model its own reasoning back", () => {
    const history = [
      stored("assistant", [
        { type: "reasoning", text: "let me think about this" },
        { type: "text", text: "here is my answer" },
      ]),
    ];

    expect(toModelMessages(history)).toEqual([
      { role: "assistant", content: "here is my answer" },
    ]);
  });

  it("marks a tool that failed so the model can see it did", () => {
    const [, toolMessage] = toModelMessages([
      stored("user", [{ type: "text", text: "fetch it" }]),
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-3",
          toolName: "web_search",
          input: { url: "https://example.com" },
          status: "error",
          failure: {
            kind: "tool_failed",
            forModel: "the site refused the connection",
            readerKey: "chat.tool.failure.unreachable",
          },
        },
      ]),
    ]).slice(1);

    expect(toolMessage).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc-3",
          output: { type: "error-text", value: "the site refused the connection" },
        },
      ],
    });
  });

  it("says a failure with no reason on record had no reason on record", () => {
    // 这个字段是后加的,库里早就躺着一批没有它的行。空字符串递给模型,读起来
    // 是「这次调用失败了,理由:」后面什么都没有 —— 而模型下一步做什么,全看
    // 它读到的这句话。
    const [, toolMessage] = toModelMessages([
      stored("user", [{ type: "text", text: "fetch it" }]),
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-9",
          toolName: "web_search",
          input: { url: "https://example.com" },
          status: "error",
        },
      ]),
    ]).slice(1);

    const output = (toolMessage as { content: Array<{ output: { value: string } }> }).content[0]!
      .output;
    expect(output.value.trim()).not.toBe("");
    expect(output.value).toBe(NOTHING_SAID_WHY.forModel);
  });

  it("keeps the line meant for a reader out of what the model is sent", () => {
    // Two audiences, two fields, and only one of them travels. The key is what
    // the panel translates; the model has no use for it and every string put
    // in front of a model is read as something it was meant to act on.
    const messages = toModelMessages([
      stored("user", [{ type: "text", text: "fetch it" }]),
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-3",
          toolName: "web_search",
          input: { url: "https://example.com" },
          status: "error",
          failure: {
            kind: "tool_failed",
            forModel: "the site refused the connection",
            readerKey: "chat.tool.failure.unreachable",
          },
        },
      ]),
    ]);

    // Every line in the table, not just the ones under the failure prefix:
    // the one for a stopped call sits outside it, so a check written against
    // the prefix reads as covering the table while missing a fifth of it.
    for (const line of Object.values(FAILURE_LINES)) {
      expect(JSON.stringify(messages)).not.toContain(line);
    }
  });

  it("tells the model the last turn was stopped by the user", () => {
    // Task #93. A stopped turn used to be dropped whole, so the next turn read
    // as one the model had finished answering -- it had no way to know its own
    // reply had been cut off, and would carry on as though it had.
    const [, toolMessage] = toModelMessages([
      stored("user", [{ type: "text", text: "search" }]),
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-4",
          toolName: "web_search",
          input: { query: "x" },
          status: "error",
          failure: {
            kind: "user_aborted",
            forModel: "The user stopped this turn while the tool was still running.",
            readerKey: "chat.tool.unfinished",
          },
        },
        { type: "interrupted" },
      ]),
    ]).slice(1);

    expect(toolMessage).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc-4",
          output: {
            type: "error-text",
            value: expect.stringContaining("stopped"),
          },
        },
      ],
    });
  });

  it("tells the model a turn stopped mid-sentence was stopped", () => {
    // Task #93's other half. No tool was ever called -- the model was writing
    // prose and the user pressed stop -- so the tool path that carries this
    // never runs, and the turn read back as one the model had finished.
    const messages = toModelMessages([
      stored("user", [{ type: "text", text: "list twenty of them" }]),
      stored("assistant", [
        { type: "text", text: "1. first 2. sec" },
        { type: "interrupted" },
      ]),
    ]);

    expect(JSON.stringify(messages)).toMatch(/did not finish/i);
  });

  it("says a turn was stopped once, at the end, however many times it spoke", () => {
    // The SDK opens a fresh text part per step, so a turn that spoke, called
    // a tool and spoke again is stored as three parts plus the mark. Saying
    // it stopped after each of them tells the model it stopped and then
    // carried on -- and the first of those notes lands before the tool call
    // it went on to make.
    const messages = toModelMessages([
      stored("assistant", [
        { type: "text", text: "let me look that up" },
        {
          type: "tool",
          toolCallId: "tc-8",
          toolName: "web_search",
          input: { query: "x" },
          status: "success",
          output: "three links",
        },
        { type: "text", text: "according to the page" },
        { type: "interrupted" },
      ]),
    ]);

    const notes = JSON.stringify(messages).match(/connection to the user closed/g) ?? [];
    expect(notes).toHaveLength(1);
  });

  it("tells the model a turn that failed did not get to finish either", () => {
    // The other way a turn ends short. The wording differs from a stop on
    // purpose: "the user stopped you" and "you did not manage to finish" lead
    // the model to different next moves.
    const messages = toModelMessages([
      stored("assistant", [{ type: "text", text: "half a sen" }, { type: "failed" }]),
    ]);

    const note = String((messages[messages.length - 1] as { content: string }).content);
    expect(note).toMatch(/broke off/i);
    expect(note).not.toMatch(/connection to the user closed/i);
  });

  it("leaves out a call whose arguments never finished arriving", () => {
    // The SDK sets `input` from a partial JSON parse on every delta, so a
    // call cut off mid-arguments carries half an address. Replaying it tells
    // the model it made a call it never made.
    const messages = toModelMessages([
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-7",
          toolName: "web_search",
          input: { url: "https://en.wikipedia.org/wiki/Bau" },
          status: "error",
          failure: {
            kind: "user_aborted",
            forModel: "stopped",
            readerKey: "chat.tool.unfinished",
          },
          argumentsIncomplete: true,
        },
        { type: "interrupted" },
      ]),
    ]);

    expect(JSON.stringify(messages)).not.toContain("wiki/Bau");
  });

  it("leaves out a call still in flight", () => {
    // The one state with nothing to replay. A stored part is never `pending`
    // -- the turn sweeps it before writing -- but the conversion is handed
    // parts from a turn still running too, and a call with no result puts the
    // exchange in a state the protocol has no move for.
    const history = [
      stored("user", [{ type: "text", text: "search" }]),
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-5",
          toolName: "web_search",
          input: { query: "x" },
          status: "pending",
        },
      ]),
    ];

    expect(toModelMessages(history)).toEqual([{ role: "user", content: "search" }]);
  });
});

describe("a replayed tool result", () => {
  it.each(["get_canvas_capabilities", "list_generation_models", "propose_canvas_action"])(
    "hands back what %s gave the model when the turn ran",
    (toolName) => {
      const output = replayedOutput([
        stored("assistant", [
          {
            type: "tool",
            toolCallId: "tc-canvas",
            toolName,
            input: {},
            status: "success",
            output: { any: "shape" },
            forModel: { type: "text", value: `what ${toolName} said` },
          },
        ]),
      ]);

      expect(output).toEqual({ type: "text", value: `what ${toolName} said` });
    },
  );

  it("hands back a json copy as it was stored", () => {
    const output = replayedOutput([
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-j",
          toolName: "judge_likelihood",
          input: {},
          status: "success",
          output: { likely: 0.8 },
          forModel: { type: "json", value: { likely: 0.8 } },
        },
      ]),
    ]);

    expect(output).toEqual({ type: "json", value: { likely: 0.8 } });
  });

  it("never reads the tool's own answer when the model's copy is there", () => {
    // An answer the current renderer would throw on: `needs` missing, which is
    // the row that failed every later turn of a conversation (inner#1481).
    const output = replayedOutput([
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-m",
          toolName: "list_generation_models",
          input: {},
          status: "success",
          output: { available: true, models: [{ name: "m", params: {} }] },
          forModel: { type: "text", value: "the models, as listed then" },
        },
      ]),
    ]);

    expect(output).toEqual({ type: "text", value: "the models, as listed then" });
  });
});

describe("a structured result stored before the model's copy was kept", () => {
  // One row in the shape each tool wrote before a field it now reads existed.
  it.each([
    ["web_search", { query: "q", sources: [{ url: "https://a.example", title: "A" }] }],
    ["search_images", { query: "q", images: [{ thumbnailUrl: "https://t.example/1.jpg" }] }],
    ["get_canvas_capabilities", { nodes: [{ nodeType: "image" }] }],
    // `needs` missing: the shape that threw in `renderNeeds`.
    [
      "list_generation_models",
      { available: true, models: [{ name: "m", displayName: "M", what: "x", seconds: 1, params: {} }] },
    ],
    // The proposal tool before it answered `placed`.
    ["propose_canvas_action", { action: "add_nodes", nodes: [], rationale: "" }],
  ])("goes to the model as a note for %s, without throwing", (toolName, output) => {
    const replayed = (): unknown =>
      replayedOutput([
        stored("assistant", [
          { type: "tool", toolCallId: "tc-old", toolName, input: {}, status: "success", output },
        ]),
      ]);

    expect(replayed).not.toThrow();
    expect(replayed()).toEqual({ type: "text", value: EARLIER_RESULT_NOTE });
  });

  it("hands a string result back as it was, since that string is what the model read", () => {
    const output = replayedOutput([
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-s",
          toolName: "web_search",
          input: {},
          status: "success",
          output: "Results for: q",
        },
      ]),
    ]);

    expect(output).toEqual({ type: "text", value: "Results for: q" });
  });
});

describe("the question a turn ended on", () => {
  it("goes back as the reply's own words and not as a call as well", () => {
    // The server writes the question into the reply as text, so the words are
    // already in the history the model reads. Sending the call and its result
    // alongside them puts the same question in the context twice, every turn
    // from here on.
    const out = toModelMessages([
      stored("assistant", [
        { type: "text", text: "哪一种？\n\n1. 一\n2. 二" },
        {
          type: "tool",
          toolCallId: "tc-9",
          toolName: "ask_user",
          input: { question: "哪一种？", options: ["一", "二"] },
          status: "success",
          output: { question: "哪一种？", options: ["一", "二"] } as unknown as string,
        },
      ]),
    ]);

    expect(out).toEqual([{ role: "assistant", content: "哪一种？\n\n1. 一\n2. 二" }]);
  });

  it("goes back as a refused call when it was turned away, so the model knows it was not asked", () => {
    // One question a turn: a second one in the same step is turned away. The
    // model reads that it was not put, so it can ask it once the first one is
    // answered.
    const out = toModelMessages([
      stored("assistant", [
        { type: "text", text: "先定节奏？" },
        {
          type: "tool",
          toolCallId: "tc-11",
          toolName: "ask_user",
          input: { question: "再定时长？" },
          status: "error",
          failure: { kind: "turned_away", forModel: "This question was not put to the user." },
        },
      ]),
    ]);

    expect(out).toContainEqual(
      expect.objectContaining({
        role: "tool",
        content: [
          expect.objectContaining({
            toolCallId: "tc-11",
            output: { type: "error-text", value: "This question was not put to the user." },
          }),
        ],
      }),
    );
  });

  it("leaves every other tool's call and result where they were", () => {
    const out = toModelMessages([
      stored("assistant", [
        {
          type: "tool",
          toolCallId: "tc-10",
          toolName: "web_search",
          input: { query: "cyberpunk" },
          status: "success",
          output: "three links",
        },
      ]),
    ]);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: "assistant" });
    expect(out[1]).toMatchObject({ role: "tool" });
  });
});

describe("a user message that carried attachments", () => {
  it("goes back to the model with its attachments in front of the words", () => {
    const chip = {
      id: "a1",
      type: "image" as const,
      name: "cover.png",
      data_snapshot: { url: "https://cdn.example/cover.png" },
    };
    const history = [
      stored("user", [
        { type: "attachment", chip },
        { type: "text", text: "what is in this?" },
      ]),
    ];

    const out = toModelMessages(history);

    expect(out).toEqual([
      { role: "user", content: userTurnForModel({ chips: [chip], message: "what is in this?" }) },
    ]);
  });
});

describe("a stored reply with DSML markup in its text", () => {
  it("is replayed to the model without the markup", () => {
    const history = [
      stored("user", [{ type: "text", text: "make a storyboard" }]),
      stored("assistant", [
        { type: "text", text: "Here is the plan.\n\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name=\"propose_canvas_action\">\n" },
      ]),
    ];

    expect(toModelMessages(history)).toContainEqual({ role: "assistant", content: "Here is the plan.\n\n" });
  });
});

describe("a questionnaire read back from its parts (inner#1542)", () => {
  const questionnaire = { questions: [{ header: "Ratio", question: "Which ratio?", multiSelect: false, options: [{ label: "16:9" }] }] };

  it("goes back as the call and the reader's answers once it is answered", () => {
    const out = toModelMessages([
      stored("assistant", [
        { type: "tool", toolCallId: "ask-1", toolName: "ask_user", input: questionnaire, status: "success", output: { answers: [{ index: 0, selected: ["16:9"] }] } },
      ]),
    ]);

    expect(out).toEqual([
      { role: "assistant", content: [expect.objectContaining({ type: "tool-call", toolCallId: "ask-1", toolName: "ask_user" })] },
      {
        role: "tool",
        content: [
          expect.objectContaining({
            type: "tool-result",
            toolCallId: "ask-1",
            output: { type: "json", value: { answers: [{ index: 0, selected: ["16:9"] }] } },
          }),
        ],
      },
    ]);
  });

  it("goes back with word that the reader wrote a message instead", () => {
    const out = toModelMessages([
      stored("assistant", [
        { type: "tool", toolCallId: "ask-2", toolName: "ask_user", input: questionnaire, status: "success", output: { repliedInChat: true } },
      ]),
    ]);

    expect(out).toContainEqual({
      role: "tool",
      content: [expect.objectContaining({ toolCallId: "ask-2", output: { type: "json", value: { repliedInChat: true } } })],
    });
  });

  it("is left out while it still waits, so no call goes without its result", () => {
    const out = toModelMessages([
      stored("assistant", [
        { type: "text", text: "Two things first." },
        { type: "tool", toolCallId: "ask-3", toolName: "ask_user", input: questionnaire, status: "awaiting" },
      ]),
    ]);

    expect(out).toEqual([{ role: "assistant", content: "Two things first." }]);
  });
});
