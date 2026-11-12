// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A message taken in while the turn runs is prepared as the opening is
 * (inner#1717): its pictures are prepared and go into the request and the
 * kept copy, its open Space goes in full only when it changed since the last
 * time this turn or the history sent it whole, its links are the user's, and
 * a Space it carries becomes what the turn's tools work against from the
 * next step on, in this stream and every later one. Where it was read stays
 * right across a fold and a second stream.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as PageLinksModule from "@server/agent/page-links.js";
import type * as PreparePicturesModule from "@server/agent/prepare-pictures.js";
import { tool, type UIMessageChunk } from "ai";
import { z } from "zod";
import type { ChatAttachedChip, ChatSpaceContext } from "@breatic/shared";
import { FINISHED, FINISHED_ASKING_FOR_A_TOOL, type ModelStreamPart } from "../helpers/model-double.js";
import type { TakenMessage } from "@server/agent/taken-message.js";

const addMessage = vi.fn(async (_id: string, _msg: Record<string, unknown>, _forModel?: unknown) => 1);
const script = vi.hoisted(() => ({
  calls: [] as Array<() => unknown[]>,
  prompts: [] as unknown[][],
  onCall: [] as Array<(() => void) | undefined>,
  /** What each call of the context-reading tools was handed, in order. */
  contexts: [] as Array<{ tool: string; context: Record<string, unknown> }>,
  /** The sources each picture preparation was asked for. */
  prepared: [] as string[][],
  links: undefined as undefined | { urlFor: (url: string) => unknown },
  onToolStart: undefined as undefined | (() => void),
}));

vi.mock("@server/agent/turn-context.js", () => ({
  buildTurnContext: vi.fn(async () => ({
    memoryContext: { entries: [], migrated: [], olderCount: 0, progress: "" },
    history: [],
  })),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    getAgentConfig: () => ({ ...(base.getAgentConfig as () => Record<string, unknown>)(), max_tool_iterations: 8 }),
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<Record<string, unknown>>();
  const { MockLanguageModelV4 } = await import("ai/test");
  /**
   * A tool that writes down the context it was handed.
   * @param name - Its name.
   * @returns The tool.
   */
  const reading = (name: string): unknown =>
    tool({
      description: name,
      inputSchema: z.object({}),
      execute: async (_input: unknown, options: { context?: unknown }) => {
        script.contexts.push({ tool: name, context: (options.context ?? {}) as Record<string, unknown> });
        return "ok";
      },
    } as never);
  let call = 0;
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    buildAgentConfig: () => ({
      modelId: "test",
      instructions: { base: "system" },
      seesPictures: true,
      tools: {
        propose_document_edit: reading("propose_document_edit"),
        search_conversations: reading("search_conversations"),
        // Runs until the turn is stopped, then says it was stopped, as every
        // real tool does whatever stopped it (`stoppedByUser` in domain).
        waits: tool({
          description: "waits",
          inputSchema: z.object({}),
          execute: async (_input: unknown, options: { abortSignal?: AbortSignal }) => {
            script.onToolStart?.();
            const { carrying, FAILURE_LINES } = await import("@breatic/shared");
            const stopped = (): Error =>
              carrying(new Error("stopped"), { kind: "user_aborted", forModel: "stopped", userKey: FAILURE_LINES.stopped });
            await new Promise((_resolve, reject) => {
              const signal = options.abortSignal;
              if (signal?.aborted === true) reject(stopped());
              signal?.addEventListener("abort", () => reject(stopped()));
            });
            return "never";
          },
        } as never),
      },
    }),
    finalizeTurn: async ({ steps }: { steps: { persist: () => Promise<void> } }) => {
      await steps.persist();
      return [];
    },
    getModel: () =>
      new MockLanguageModelV4({
        // Read pictures by their URL, as the real providers do.
        supportedUrls: { "image/*": [/^https:\/\//] },
        doStream: async (asked) => {
          const i = call++;
          script.prompts.push(asked.prompt);
          script.onCall[i]?.();
          const parts = (script.calls[i] ?? script.calls.at(-1)!)() as ModelStreamPart[];
          return {
            stream: new ReadableStream<ModelStreamPart>({
              start(controller) {
                for (const p of parts) controller.enqueue(p);
                controller.close();
              },
            }),
          };
        },
      }),
    __resetCalls: () => {
      call = 0;
    },
  };
});

vi.mock("@server/agent/project-records.js", () => ({
  projectRecordsFor: (scope: Record<string, unknown>) => ({ scope }),
}));

vi.mock("@server/agent/prepare-pictures.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PreparePicturesModule>();
  return {
    ...actual,
    picturePreparerFor: () => async (sources: ReadonlyArray<{ label: string; sourceUrl: string }>) => {
      script.prepared.push(sources.map((s) => s.sourceUrl));
      return sources.map((s) => ({
        status: "ready" as const,
        label: s.label,
        sourceUrl: s.sourceUrl,
        url: `https://storage.example.com/prepared/${encodeURIComponent(s.sourceUrl)}.jpg`,
        sizeBytes: 100,
        mediaType: "image/jpeg",
      }));
    },
  };
});

vi.mock("@server/agent/page-links.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PageLinksModule>();
  return {
    ...actual,
    makePageLinks: () => {
      const links = actual.makePageLinks();
      script.links = links;
      return links;
    },
  };
});

vi.mock("@server/modules/conversation/conversation-message.repo.js", () => ({
  addMessage,
  addUserMessage: async (id: string, msg: Record<string, unknown>) => ({ turnIndex: await addMessage(id, msg), closedAsks: [] }),
  getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
  setUserForModel: vi.fn(async () => {}),
}));
vi.mock("@server/modules/conversation/conversation.service.js", () => ({
  getMessagesForLlm: async () => [],
  titleForTurn: vi.fn(async () => "named"),
}));
vi.mock("@server/agent/turn-fold.js", () => ({ foldIfTooLong: vi.fn(async () => "none") }));
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const { MainAgent } = await import("@server/agent/main-agent.js");
const { runWithContext } = await import("@breatic/core");
const { foldIfTooLong } = await import("@server/agent/turn-fold.js");
const domain = (await import("@breatic/domain")) as unknown as { __resetCalls: () => void };

/**
 * A step that calls one of the tools.
 * @param name - The tool.
 * @param id - The call's id.
 * @returns The step's parts.
 */
const calls = (name: string, id: string) => (): unknown[] => [
  { type: "tool-call", toolCallId: id, toolName: name, input: "{}" },
  FINISHED_ASKING_FOR_A_TOOL,
];

/**
 * A step that only says something.
 * @param text - What.
 * @returns The step's parts.
 */
const says = (text: string) => (): unknown[] => [
  { type: "text-start", id: `t-${text}` },
  { type: "text-delta", id: `t-${text}`, delta: text },
  { type: "text-end", id: `t-${text}` },
  FINISHED,
];

/**
 * An open document, loaded.
 * @param id - Its id.
 * @param words - Its one block's text.
 * @returns The Space as a message carries it.
 */
function documentOpen(id: string, words: string): NonNullable<ChatSpaceContext["current_space"]> {
  return {
    id,
    name: `Doc ${id}`,
    kind: "document",
    state: "loaded",
    content: words,
    total_chars: words.length,
    blocks: [{ id: `${id}-b1`, text: words }],
  } as never;
}

/**
 * An open canvas, loaded.
 * @param id - Its id.
 * @param words - What it reads as.
 * @returns The Space as a message carries it.
 */
function canvasOpen(id: string, words: string): NonNullable<ChatSpaceContext["current_space"]> {
  return { id, name: `Canvas ${id}`, kind: "canvas", state: "loaded", content: words, total_chars: words.length } as never;
}

/**
 * A message as the run hands it over.
 * @param id - Its id.
 * @param words - What the user typed.
 * @param more - Its Spaces and chips.
 * @returns The message.
 */
function taken(id: string, words: string, more: { space?: ChatSpaceContext; chips?: ChatAttachedChip[] } = {}): TakenMessage {
  return { id, sentAt: "2026-11-12T08:00:00.000Z", message: words, chips: more.chips ?? [], space: more.space ?? {} };
}

/**
 * An image attachment.
 * @param url - Where it is.
 * @returns The chip.
 */
function imageChip(url: string): ChatAttachedChip {
  return { id: `chip-${url}`, type: "image", name: "pic", data_snapshot: { url } };
}

let waiting: TakenMessage[] = [];

/**
 * Run one turn to its end, taking in what waits.
 * @param space - The opening's Spaces.
 * @param chips - The opening's attachments.
 * @param signal - Raised to stop the turn.
 * @returns Every chunk the turn wrote.
 */
async function runTurn(space: ChatSpaceContext = {}, chips: ChatAttachedChip[] = [], signal?: AbortSignal): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const turn = await new MainAgent().chat("open", signal, chips, undefined, space, undefined, {
      messageId: "m1",
      drain: async () => {
        const got = waiting;
        waiting = [];
        return got;
      },
    });
    for await (const chunk of turn) out.push(chunk);
  });
  return out;
}

/**
 * The user messages of a prompt, as text.
 * @param prompt - What the model was sent.
 * @returns Each user message's text.
 */
function userTexts(prompt: unknown[]): string[] {
  return (prompt as Array<{ role: string; content: unknown }>)
    .filter((m) => m.role === "user")
    .map((m) => JSON.stringify(m.content));
}

/** The stored reply, as the last `addMessage` for the assistant was given it. */
function storedReply(): { parts: Array<Record<string, unknown>>; forModel: Record<string, unknown> & { messages: Array<{ role: string; content: unknown }> } } {
  const call = addMessage.mock.calls.filter((c) => (c[1] as { role: string }).role === "assistant").at(-1)!;
  return { parts: (call[1] as { parts: Array<Record<string, unknown>> }).parts, forModel: call[2] as never };
}

beforeEach(() => {
  addMessage.mockClear();
  vi.mocked(foldIfTooLong).mockReset();
  vi.mocked(foldIfTooLong).mockResolvedValue("none");
  script.calls = [];
  script.prompts = [];
  script.onCall = [];
  script.contexts = [];
  script.prepared = [];
  script.links = undefined;
  script.onToolStart = undefined;
  waiting = [];
  domain.__resetCalls();
});

describe("a Space a taken message carries", () => {
  it("is what the turn's tools work against from the next step on, in this stream and the next (PS-04)", async () => {
    script.calls = [
      calls("propose_document_edit", "p1"),
      calls("propose_document_edit", "p2"),
      calls("propose_document_edit", "p3"),
      calls("search_conversations", "s1"),
      says("said"),
      calls("propose_document_edit", "p4"),
      says("done"),
    ];
    script.onCall[0] = () => waiting.push(taken("a", "look at this one", { space: { current_space: documentOpen("D2", "second doc") } }));
    script.onCall[1] = () => waiting.push(taken("b", "no space here"));
    script.onCall[2] = () => waiting.push(taken("c", "these spaces", { space: { spaces: [{ id: "S9", name: "Nine", kind: "canvas" }] as never } }));
    script.onCall[4] = () => waiting.push(taken("d", "one more"));
    await runTurn({ current_space: documentOpen("D1", "first doc"), spaces: [{ id: "S1", name: "One", kind: "document" }] as never });

    const docs = script.contexts.filter((c) => c.tool === "propose_document_edit").map((c) => (c.context.openDocument as { spaceId?: string } | null)?.spaceId);
    expect(docs).toEqual(["D1", "D2", "D2", "D2"]);
    const records = script.contexts.find((c) => c.tool === "search_conversations")!.context.records as { scope: { spaces: Array<{ id: string }> } };
    expect(records.scope.spaces.map((s) => s.id)).toEqual(["S9"]);
  });
});

describe("a taken message's open Space", () => {
  it("goes in full when it changed since the turn last sent it whole, and as one line when it did not (PS-16)", async () => {
    script.calls = [calls("search_conversations", "s1"), calls("search_conversations", "s2"), says("done")];
    script.onCall[0] = () => waiting.push(taken("a", "now this", { space: { current_space: canvasOpen("S2", "CAST OF S-TWO") } }));
    script.onCall[1] = () => waiting.push(taken("b", "still this", { space: { current_space: canvasOpen("S2", "CAST OF S-TWO") } }));
    await runTurn({ current_space: canvasOpen("S1", "CAST OF S-ONE") });
    const last = userTexts(script.prompts[2]!);
    const a = last.find((t) => t.includes("now this"))!;
    const b = last.find((t) => t.includes("still this"))!;
    expect(a).toContain("CAST OF S-TWO");
    expect(b).not.toContain("CAST OF S-TWO");
  });
});

describe("a taken message's pictures", () => {
  it("are prepared, sent from its step on and kept at the end of the reply's pictures (PS-15)", async () => {
    script.calls = [calls("search_conversations", "s1"), calls("search_conversations", "s2"), says("done")];
    script.onCall[0] = () => waiting.push(taken("a", "see this", { chips: [imageChip("https://example.com/cat.png")] }));
    await runTurn();
    expect(script.prepared).toContainEqual(["https://example.com/cat.png"]);
    const prepared = "https://storage.example.com/prepared/" + encodeURIComponent("https://example.com/cat.png") + ".jpg";
    expect(JSON.stringify(script.prompts[1])).toContain(prepared);
    expect(JSON.stringify(script.prompts[2])).toContain(prepared);
    const pictures = storedReply().forModel.pictures as Array<{ url: string }>;
    expect(pictures.at(-1)?.url).toBe(prepared);
  });
});

describe("a taken message's links", () => {
  it("are the user's, so a later read of one is let through (PS-17)", async () => {
    script.calls = [calls("search_conversations", "s1"), says("done")];
    script.onCall[0] = () => waiting.push(taken("a", "read https://example.com/x please"));
    await runTurn();
    expect(script.links?.urlFor("https://example.com/x")).toBeDefined();
  });
});

describe("the opening and a taken message", () => {
  it("are prepared alike: the same words and Space give the same user message (PS-19)", async () => {
    const space: ChatSpaceContext = { current_space: canvasOpen("S1", "CAST OF S-ONE") };
    script.calls = [calls("search_conversations", "s1"), says("done")];
    script.onCall[0] = () => waiting.push(taken("a", "open", { space: { current_space: canvasOpen("S3", "CAST OF S-THREE") } }));
    await runTurn(space, [imageChip("https://example.com/dog.png")]);
    const opening = userTexts(script.prompts[0]!).at(-1)!;
    expect(opening).toContain("CAST OF S-ONE");
    expect(opening).toContain(encodeURIComponent("https://example.com/dog.png"));
    expect(script.prepared[0]).toEqual(["https://example.com/dog.png"]);
  });
});

describe("where a taken message was read", () => {
  it("counts the steps of every stream, a fold between them included (PS-09)", async () => {
    // The third call is turned away as too long; the fold moves, and the
    // stream after it reads `m2` before its first step, the turn's third.
    const { h1 } = await import("../helpers/overflow-turn.js");
    script.calls = [
      calls("search_conversations", "s1"),
      calls("search_conversations", "s2"),
      () => [{ type: "error", error: h1() }],
      says("done"),
    ];
    vi.mocked(foldIfTooLong).mockImplementation(async (_sent, _finished, _who, trigger) => (trigger.kind === "precheck" ? "none" : "moved"));
    script.onCall[2] = () => waiting.push(taken("m2", "after the fold"));
    await runTurn();
    const { parts, forModel } = storedReply();
    expect(parts.map((p) => p.type)).toEqual(["tool", "tool", "user-message", "text"]);
    const roles = forModel.messages.map((m) => m.role);
    expect(roles.slice(0, 5)).toEqual(["assistant", "tool", "assistant", "tool", "user"]);
  });

  it("is in a step's request once when that step's precheck folds (PS-10)", async () => {
    script.calls = [calls("search_conversations", "s1"), calls("search_conversations", "s2"), says("done")];
    vi.mocked(foldIfTooLong).mockResolvedValueOnce("none").mockResolvedValueOnce("moved").mockResolvedValue("none");
    script.onCall[0] = () => waiting.push(taken("a", "message a"));
    script.onCall[1] = () => waiting.push(taken("b", "message b"));
    await runTurn();
    const prompt = script.prompts[2]!;
    const texts = userTexts(prompt);
    expect(texts.filter((t) => t.includes("message a"))).toHaveLength(1);
    expect(texts.filter((t) => t.includes("message b"))).toHaveLength(1);
    expect(texts.at(-1)).toContain("message b");
  });

  it("is in the request once after the provider turned a call away and the fold moved (PS-11)", async () => {
    const { h1 } = await import("../helpers/overflow-turn.js");
    script.calls = [calls("search_conversations", "s1"), () => [{ type: "error", error: h1() }], says("done")];
    vi.mocked(foldIfTooLong).mockImplementation(async (_sent, _finished, _who, trigger) => (trigger.kind === "precheck" ? "none" : "moved"));
    script.onCall[0] = () => waiting.push(taken("a", "message a"));
    await runTurn();
    const texts = userTexts(script.prompts.at(-1)!);
    expect(texts.filter((t) => t.includes("message a"))).toHaveLength(1);
  });

  it("moves the next step's start by what was taken before it (PS-14)", async () => {
    script.calls = [calls("search_conversations", "s1"), says("done")];
    script.onCall[0] = () => waiting.push(taken("a", "message a"));
    await runTurn();
    const steps = storedReply().forModel.steps as Array<{ messageStart: number; messageEnd: number }>;
    expect(steps[1]!.messageStart).toBe(steps[0]!.messageStart + 2 + 1);
  });
});

describe("a tool running when a shutdown stops the turn", () => {
  it("is stored as an error, not as stopped by the user (SD-05)", async () => {
    const { ShutdownAbort } = await import("@server/agent/shutdown-flag.js");
    const stop = new AbortController();
    script.calls = [calls("waits", "w1"), says("never said")];
    script.onToolStart = () => stop.abort(new ShutdownAbort());
    await runTurn({}, [], stop.signal);
    const part = storedReply().parts.find((p) => p.type === "tool" && p.toolCallId === "w1") as { status: string; failure?: { kind: string } };
    expect(part.status).toBe("error");
    expect(part.failure?.kind).not.toBe("user_aborted");
    expect(storedReply().parts).toContainEqual({ type: "failed", reason: "shutdown" });
  });
});
