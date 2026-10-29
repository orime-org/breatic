// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A turn run against a scripted model and a small fake conversation, for the
 * cases about folding memory when the request does not fit (inner#1567).
 *
 * The model is the double, so `streamText` runs for real: it calls the tools,
 * honours the stop signal and assembles the reply the turn stores. Each call
 * of the model takes the next entry of `world.script`: either a stream of
 * parts or a rejection, which is how a provider turns a request away before a
 * stream exists (H1, H2 in the probe). The conversation is `world.history`,
 * read through a fake `buildTurnContext` that honours the watermark, and a
 * fold is a fake `consolidateWindow` that moves the watermark and rewrites
 * the conversation memory the way a written fold does.
 *
 * A test file mocks each module with the factories below and reads
 * everything that happened off `world`.
 */

import { vi } from "vitest";
import { APICallError, RetryError, tool } from "ai";
import type { ModelMessage, UIMessageChunk } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import type { MessageData } from "@breatic/shared";
import type { ModelStreamPart } from "./model-double.js";

const URL = "https://openrouter.ai/api/v1/chat/completions";

/** H1 as OpenRouter returned it on 2026-10-25: a first request over the window. */
export const H1_MESSAGE = "[Relace] This model's maximum context length is 1048576 tokens. However, your prompt contains at least 1048577 input tokens, which exceeds this limit even without any output tokens. Please reduce the length of the input prompt. (parameter=input_tokens, value=1048577)";
const H1_BODY = "{\"error\":{\"message\":\"Provider returned error\",\"code\":400,\"metadata\":{\"raw\":\"{\\\"error\\\":{\\\"message\\\":\\\"This model's maximum context length is 1048576 tokens. However, your prompt contains at least 1048577 input tokens, which exceeds this limit even without any output tokens. Please reduce the length of the input prompt. (parameter=input_tokens, value=1048577)\\\",\\\"type\\\":\\\"BadRequestError\\\",\\\"param\\\":\\\"input_tokens\\\",\\\"code\\\":400}}\",\"provider_name\":\"Relace\",\"is_byok\":false,\"provider_error_code\":\"400\"}},\"user_id\":\"org_REDACTED\"}";
/** H2 as OpenRouter returned it on 2026-10-25: a second step over the window, after a tool ran. */
export const H2_MESSAGE = "[DigitalOcean] this model's maximum context length is 1048576 tokens, but the prompt contains 2021458 input tokens";
const H2_BODY = "{\"error\":{\"message\":\"Provider returned error\",\"code\":400,\"metadata\":{\"raw\":\"{\\\"error\\\":{\\\"message\\\":\\\"this model's maximum context length is 1048576 tokens, but the prompt contains 2021458 input tokens\\\",\\\"type\\\":\\\"invalid_request_error\\\"},\\\"message\\\":\\\"this model's maximum context length is 1048576 tokens, but the prompt contains 2021458 input tokens\\\",\\\"status_code\\\":400}\\n\",\"provider_name\":\"DigitalOcean\",\"is_byok\":false}},\"user_id\":\"org_REDACTED\"}";

/** The window the probe's model reported, which H1 and H2 count against. */
export const PROBE_WINDOW = 1_048_576;

/**
 * An error the way the SDK hands it over after a failed model call.
 * @param statusCode - The HTTP status.
 * @param message - The error message.
 * @param responseBody - The raw response body.
 * @param isRetryable - Whether the SDK may retry it.
 * @returns The error.
 */
function apiError(statusCode: number, message: string, responseBody?: string, isRetryable = false): APICallError {
  return new APICallError({
    message,
    url: URL,
    requestBodyValues: {},
    statusCode,
    isRetryable,
    ...(responseBody === undefined ? {} : { responseBody }),
  });
}

/**
 * H1, verbatim: the count it carries is a lower bound, one over the window.
 * @returns The error.
 */
export function h1(): APICallError {
  return apiError(400, H1_MESSAGE, H1_BODY);
}

/**
 * H2, verbatim: the exact count, 2,021,458 tokens.
 * @returns The error.
 */
export function h2(): APICallError {
  return apiError(400, H2_MESSAGE, H2_BODY);
}

/**
 * An overflow OpenRouter marks with `error_type` and no count anywhere.
 * @returns The error.
 */
export function overflowWithoutCount(): APICallError {
  const body = JSON.stringify({
    error: { message: "Provider returned error", code: 400, metadata: { error_type: "context_length_exceeded", provider_name: "Alibaba" } },
  });
  return apiError(400, "Provider returned error", body);
}

/**
 * A rate limit, which is never an overflow.
 * @returns The error.
 */
export function rateLimited(): APICallError {
  return apiError(429, "Rate limit exceeded: free-models-per-min.", "{\"error\":{\"message\":\"Rate limit exceeded\",\"code\":429}}", true);
}

/**
 * H1 as the SDK throws it after retrying: a rate limit first, then the overflow.
 * @returns The error.
 */
export function h1AfterRetry(): RetryError {
  return new RetryError({
    message: `Failed after 2 attempts. Last error: ${H1_MESSAGE}`,
    reason: "errorNotRetryable",
    errors: [rateLimited(), h1()],
  });
}

/** One call of the model: what it streams back, or how it is turned away. */
export type ScriptedCall = { parts: ModelStreamPart[] } | { reject: unknown };

/** A finished step with what the provider reported for it. */
type Finish = Extract<ModelStreamPart, { type: "finish" }>;

/**
 * One step's ending, with the usage the provider reported.
 * @param unified - Why the step ended.
 * @param input - Input tokens of the call.
 * @param output - Output tokens of the call.
 * @returns The finish part.
 */
export function finish(unified: Finish["finishReason"]["unified"], input: number, output: number): ModelStreamPart {
  return {
    type: "finish",
    finishReason: { unified, raw: undefined },
    usage: {
      inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: output, text: output, reasoning: 0 },
    },
  };
}

/**
 * A call that answers in prose and ends the turn.
 * @param text - What it says.
 * @param input - Input tokens reported.
 * @param output - Output tokens reported.
 * @returns The call.
 */
export function answers(text: string, input = 100, output = 10): ScriptedCall {
  return {
    parts: [
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: text },
      { type: "text-end", id: "t1" },
      finish("stop", input, output),
    ],
  };
}

/**
 * A call that thinks, then answers in prose and ends the turn.
 * @param text - What it says.
 * @returns The call.
 */
export function thinksThenAnswers(text: string): ScriptedCall {
  return {
    parts: [
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "weighing it up" },
      { type: "reasoning-end", id: "r1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: text },
      { type: "text-end", id: "t1" },
      finish("stop", 100, 10),
    ],
  };
}

/** The signature a provider puts on the thinking of a tool round, through OpenRouter. */
export const SIGNATURE = "SIGNED-THINKING-0xC0FFEE";

/**
 * A call that asks for `fetch_page`.
 * @param toolCallId - The call's id.
 * @param input - Input tokens reported.
 * @param output - Output tokens reported.
 * @param thinks - Think first, signing the call the way OpenRouter does.
 * @returns The call.
 */
export function callsFetch(toolCallId: string, input = 100, output = 10, thinks = false): ScriptedCall {
  return { parts: [...(thinks ? signedThinking() : []), fetchCall(toolCallId, thinks), finish("tool-calls", input, output)] };
}

/**
 * A call that puts a questionnaire to the reader.
 * @param toolCallId - The call's id.
 * @param input - Input tokens reported.
 * @param output - Output tokens reported.
 * @param thinks - Think first, signing the call the way OpenRouter does.
 * @returns The call.
 */
export function asks(toolCallId: string, input = 100, output = 10, thinks = false): ScriptedCall {
  return {
    parts: [
      ...(thinks ? signedThinking() : []),
      {
        type: "tool-call",
        toolCallId,
        toolName: "ask_user",
        input: JSON.stringify({ questions: [] }),
        ...(thinks ? { providerMetadata: signed() } : {}),
      },
      finish("tool-calls", input, output),
    ],
  };
}

/**
 * The provider metadata a signed thinking block rides on.
 * @returns The metadata.
 */
function signed(): { openrouter: { reasoning_details: Array<{ type: string; data: string }> } } {
  return { openrouter: { reasoning_details: [{ type: "reasoning.encrypted", data: SIGNATURE }] } };
}

/**
 * A stretch of thinking, signed.
 * @returns Its parts.
 */
function signedThinking(): ModelStreamPart[] {
  return [
    { type: "reasoning-start", id: "r0", providerMetadata: signed() },
    { type: "reasoning-delta", id: "r0", delta: "PAUSED-STEP-THINKING" },
    { type: "reasoning-end", id: "r0", providerMetadata: signed() },
  ];
}

/**
 * The `fetch_page` call part.
 * @param toolCallId - The call's id.
 * @param signedCall - Carry the thinking signature on the call.
 * @returns The part.
 */
function fetchCall(toolCallId: string, signedCall: boolean): ModelStreamPart {
  return {
    type: "tool-call",
    toolCallId,
    toolName: "fetch_page",
    input: JSON.stringify({ url: "https://example.test/page" }),
    ...(signedCall ? { providerMetadata: signed() } : {}),
  };
}

/** What the fake conversation holds and everything a turn did to it. */
export interface World {
  /** Configuration the turn reads, over the shared test config. */
  config: Record<string, unknown>;
  /** The main model's context window the agent config resolves to. */
  window: number;
  /** Every stored row of the conversation, folded or not. */
  history: Array<MessageData & { forModel: unknown }>;
  /** How far the conversation is folded. */
  watermark: number;
  /** The conversation memory a fold wrote last. */
  memory: string;
  /** What the model does, call by call. */
  script: ScriptedCall[];
  /** What each model call was handed. */
  prompts: unknown[][];
  /** The order things happened in: `call`, `fold`, `tool`, `context`. */
  events: string[];
  /** How the folds end, fold by fold; `written` once this runs out. */
  foldOutcomes: Array<"written" | "discarded" | "superseded" | "aborted" | "untouched">;
  /** What each fold was handed. */
  folds: Array<Record<string, unknown>>;
  /** Reads of the context after which every further read throws. */
  failReadsAfter: number | undefined;
  /** Raised by a fold that ends `aborted`, and handed to the turn. */
  controller: AbortController;
  /** Run while `fetch_page` executes. */
  duringTool: (() => void) | undefined;
  /** What `fetch_page` answers. */
  toolOutput: string;
  /** How many times `fetch_page` ran. */
  toolRuns: number;
  /** The turn index the next reader message is filed under. */
  nextTurn: number;
  /** Reader messages written, with their turn. */
  readerMessages: Array<{ turnIndex: number; message: { parts: MessageData["parts"] } }>;
  /** Every `setUserForModel` write. */
  userForModel: Array<{ turnIndex: number; kept: { messages: ModelMessage[]; snapshot?: unknown } }>;
  /** Every reply row written, with what was kept for the model. */
  replies: Array<{ message: { role: string; parts: MessageData["parts"]; turnIndex: number }; forModel: Record<string, unknown> | undefined }>;
  /** Every model call a usage recorder was handed, under the recorder's key. */
  recorded: Array<{ key: string; usage: { inputTokens?: number; outputTokens?: number } }>;
  /** Every charge taken. */
  charges: Array<{ key: string; amount: number }>;
  /** The type of every chunk on the wire so far, in order, as it arrives. */
  wire: string[];
  /** Awaited inside each fold before it ends. */
  duringFold: (() => Promise<void>) | undefined;
}

/**
 * A world with nothing in it.
 * @returns The world.
 */
function emptyWorld(): World {
  return {
    config: {},
    window: PROBE_WINDOW,
    history: [],
    watermark: 0,
    memory: "",
    script: [],
    prompts: [],
    events: [],
    foldOutcomes: [],
    folds: [],
    failReadsAfter: undefined,
    controller: new AbortController(),
    duringTool: undefined,
    toolOutput: "the page",
    toolRuns: 0,
    nextTurn: 1,
    readerMessages: [],
    userForModel: [],
    replies: [],
    recorded: [],
    charges: [],
    wire: [],
    duringFold: undefined,
  };
}

/** The one world every factory and every case shares. */
export const world: World = emptyWorld();

/** The configuration every case starts from: small numbers so the lines can be read. */
export const BASE_CONFIG: Record<string, unknown> = {
  default_model: "test",
  main_model_sees_pictures: "no",
  max_output_tokens: 16_384,
  // Above the window less the output reserve, so the window term sets the fold target.
  memory_keep_tokens: 2_000_000,
  memory_conversation_max_size: 1000,
  memory_project_max_size: 1000,
  max_tool_iterations: 8,
  llm_max_retries: 0,
  overflow_folds_per_turn: 2,
  consolidation_shrink_attempts: 3,
  context_window_fallback_tokens: 1_000_000,
};

/**
 * Put the world back to empty, for the next case.
 * @throws {never} Never.
 */
export function resetWorld(): void {
  Object.assign(world, emptyWorld(), { config: { ...BASE_CONFIG } });
}

/** The tools every turn runs with: one that answers, one that asks. */
export const TOOLS = {
  fetch_page: tool({
    description: "Fetch a web page.",
    inputSchema: z.object({ url: z.string() }),
    execute: async () => {
      world.events.push("tool");
      world.toolRuns += 1;
      world.duringTool?.();
      return world.toolOutput;
    },
  }),
  ask_user: tool({
    description: "Ask the reader.",
    inputSchema: z.object({ questions: z.array(z.unknown()) }),
  }),
};

/**
 * The model, as the turn gets it from `getModel`.
 * @returns A model that plays `world.script`.
 */
export function scriptedModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (asked) => {
      world.events.push("call");
      world.prompts.push(structuredClone(asked.prompt));
      const next = world.script.shift();
      if (next === undefined) throw new Error("the model was called more times than this case scripted");
      if ("reject" in next) throw next.reject;
      const parts = [...next.parts];
      return {
        stream: new ReadableStream<ModelStreamPart>({
          async pull(controller) {
            // Each part arrives in a task of its own, as a provider's does
            // over the network; parts handed out within one task are read
            // ahead through the SDK's transform streams before the turn
            // handles the first, by how far depends on the Node version.
            await new Promise((resolve) => setTimeout(resolve, 0));
            // Each part a few milliseconds after the last, so a stretch of
            // thinking has a length.
            if (vi.isFakeTimers()) vi.setSystemTime(Date.now() + 7);
            const part = parts.shift();
            if (part === undefined) controller.close();
            else controller.enqueue(part);
          },
        }),
      };
    },
  });
}

/**
 * One turn of plain stored history, sized to order, with no kept copy.
 * @param turnIndex - Its turn.
 * @param size - Characters in the reply.
 * @returns The two rows.
 */
export function plainTurn(turnIndex: number, size: number): Array<MessageData & { forModel: unknown }> {
  const said = `question ${String(turnIndex)}`;
  const reply = `TURN-${String(turnIndex)}-REPLY ` + "a".repeat(size);
  return [
    { role: "user", content: said, parts: [{ type: "text", text: said }], ts: "", turnIndex, forModel: null },
    { role: "assistant", content: reply, parts: [{ type: "text", text: reply }], ts: "", turnIndex, forModel: null },
  ];
}

/**
 * The rows a turn this world ran left behind, as the repository reads them back.
 * @param turnIndex - The turn.
 * @returns Its reader row and every reply row, oldest first.
 * @throws {Error} When the turn left no reader message.
 */
export function rowsOf(turnIndex: number): Array<MessageData & { forModel: unknown }> {
  const reader = world.readerMessages.find((one) => one.turnIndex === turnIndex);
  const kept = world.userForModel.filter((one) => one.turnIndex === turnIndex).at(-1)?.kept;
  const rows: Array<MessageData & { forModel: unknown }> = [];
  if (reader !== undefined) {
    const text = reader.message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
    rows.push({ role: "user", content: text, parts: reader.message.parts, ts: "", turnIndex, forModel: kept ?? null });
  }
  for (const reply of world.replies.filter((one) => one.message.turnIndex === turnIndex)) {
    const text = reply.message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
    rows.push({ role: "assistant", content: text, parts: reply.message.parts, ts: "", turnIndex, forModel: structuredClone(reply.forModel) });
  }
  if (rows.length === 0) throw new Error(`turn ${String(turnIndex)} left nothing behind`);
  return rows;
}

/**
 * The last reply row written.
 * @returns The row and what it kept for the model.
 * @throws {Error} When no reply was written.
 */
export function lastReply(): World["replies"][number] {
  const reply = world.replies.at(-1);
  if (reply === undefined) throw new Error("no reply was stored");
  return reply;
}

/**
 * The `@breatic/core` mock: the shared test core with the turn's numbers from `world.config`.
 * @param importOriginal - Vitest's loader of the real module.
 * @returns The module.
 */
export async function overflowCore(importOriginal: <T>() => Promise<T>): Promise<Record<string, unknown>> {
  const { coreMock } = await import("./mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    getAgentConfig: () => ({ ...(base.getAgentConfig as () => Record<string, unknown>)(), ...world.config }),
  };
}

/**
 * The `@breatic/domain` mock: the real stream and finalizer, a scripted
 * model, an agent config carrying `world.window`, and every recording and
 * charge kept on `world`.
 * @returns The module.
 */
export async function overflowDomain(): Promise<Record<string, unknown>> {
  const { domainMock } = await import("./mock-core.js");
  const base = domainMock() as Record<string, unknown>;
  const actual = await vi.importActual<Record<string, unknown>>("@breatic/domain");
  const instructionsForAgentMemory = actual.instructionsForAgentMemory as (
    base: string,
    memory?: { projectMemory: string; conversationMemory: string },
  ) => unknown;
  const recorderOf = base.createUsageRecorder as (options: { operationKey: string }) => {
    recordModelCall: (call: { usage: { inputTokens?: number; outputTokens?: number } }) => void;
  };
  return {
    ...base,
    streamTextRetry: actual.streamTextRetry,
    finalizeTurn: actual.finalizeTurn,
    resolveProvider: () => "test",
    getModel: () => scriptedModel(),
    buildAgentConfig: async (request: { basePrompt: string; memoryContext?: { projectMemory: string; conversationMemory: string } }) => ({
      modelId: "test",
      instructions: instructionsForAgentMemory(request.basePrompt, request.memoryContext),
      tools: TOOLS,
      seesPictures: false,
      contextWindow: world.window,
    }),
    createUsageRecorder: (options: { operationKey: string }) => {
      const recorder = recorderOf(options);
      return {
        ...recorder,
        recordModelCall: (call: { usage: { inputTokens?: number; outputTokens?: number } }) => {
          world.recorded.push({ key: options.operationKey, usage: call.usage });
          recorder.recordModelCall(call);
        },
      };
    },
    creditLotService: {
      chargeOnceForGeneration: async (key: string, charge: { amount: number }) => {
        world.charges.push({ key, amount: charge.amount });
        return null;
      },
    },
  };
}

/**
 * The conversation repository, writing into `world`.
 * @returns The module.
 */
export function overflowRepo(): Record<string, unknown> {
  return {
    addReaderMessage: async (_conversationId: string, message: { parts: MessageData["parts"] }) => {
      const turnIndex = world.nextTurn;
      world.readerMessages.push({ turnIndex, message });
      return { turnIndex, closedAsks: [] };
    },
    setUserForModel: async (_conversationId: string, turnIndex: number, kept: World["userForModel"][number]["kept"]) => {
      world.userForModel.push({ turnIndex, kept: structuredClone(kept) });
    },
    addMessage: async (_conversationId: string, message: World["replies"][number]["message"], forModel?: Record<string, unknown>) => {
      world.replies.push({ message, forModel });
      return message.turnIndex;
    },
    getMessages: async () => ({ messages: [], hasMore: false }),
  };
}

/**
 * `buildTurnContext`, reading `world` from the watermark on.
 * @returns The module.
 */
export function overflowTurnContext(): Record<string, unknown> {
  return {
    buildTurnContext: async (_u: string, _c: string, _p: string, before: number) => {
      world.events.push("context");
      if (world.failReadsAfter !== undefined && world.events.filter((e) => e === "context").length > world.failReadsAfter) {
        throw new Error("connection terminated unexpectedly");
      }
      return {
        memoryContext: { projectMemory: "", conversationMemory: world.memory },
        history: world.history.filter((row) => row.turnIndex > world.watermark && row.turnIndex < before),
        watermark: world.watermark,
      };
    },
  };
}

/**
 * `consolidateWindow`, moving the watermark the way each ending does.
 * @returns The module.
 */
export function overflowConsolidator(): Record<string, unknown> {
  return {
    consolidateWindow: async (window: Record<string, unknown>) => {
      world.events.push("fold");
      world.folds.push(window);
      await world.duringFold?.();
      const outcome = world.foldOutcomes.shift() ?? "written";
      if (outcome === "written" || outcome === "superseded" || outcome === "discarded") {
        world.watermark = window.newWatermark as number;
        if (outcome !== "discarded") world.memory = `MEMORY-THROUGH-${String(window.newWatermark)}`;
      }
      if (outcome === "aborted") world.controller.abort();
      return outcome;
    },
  };
}

/**
 * Send one reader message and read the turn to its end.
 * @param said - What the reader wrote.
 * @param space - The reader's Spaces.
 * @returns Every chunk the turn put on the wire.
 */
export async function sendMessage(said = "hi", space: Record<string, unknown> = {}): Promise<UIMessageChunk[]> {
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = (await import("@breatic/core")) as unknown as {
    runWithContext: <T>(ctx: Record<string, string>, fn: () => Promise<T>) => Promise<T>;
  };
  const chunks: UIMessageChunk[] = [];
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const stream = await new MainAgent().chat(said, world.controller.signal, [], "UTC", space);
    for await (const chunk of stream) {
      chunks.push(chunk);
      world.wire.push(chunk.type);
    }
  });
  world.nextTurn += 1;
  return chunks;
}

/**
 * Resume a turn that stopped at a questionnaire and read it to its end.
 * @param toolCallId - The questionnaire answered.
 * @param turnIndex - The turn that asked.
 * @param space - The reader's Spaces when they answered.
 * @returns Every chunk the segment put on the wire.
 */
export async function sendAnswer(toolCallId: string, turnIndex: number, space: Record<string, unknown> = {}): Promise<UIMessageChunk[]> {
  const { MainAgent } = await import("@server/agent/main-agent.js");
  const { runWithContext } = (await import("@breatic/core")) as unknown as {
    runWithContext: <T>(ctx: Record<string, string>, fn: () => Promise<T>) => Promise<T>;
  };
  const chunks: UIMessageChunk[] = [];
  await runWithContext({ userId: "u1", conversationId: "c1", projectId: "p1" }, async () => {
    const stream = await new MainAgent().answer(toolCallId, { answers: [] }, turnIndex, world.controller.signal, "UTC", space);
    for await (const chunk of stream) chunks.push(chunk);
  });
  return chunks;
}

/**
 * The types of the chunks of one turn, in order.
 * @param chunks - The turn's chunks.
 * @returns Their types.
 */
export function typesOf(chunks: readonly UIMessageChunk[]): string[] {
  return chunks.map((chunk) => chunk.type);
}

/**
 * The tool calls and tool results one request carried, by call id.
 * @param prompt - What one model call was handed.
 * @returns The ids of the calls and of the results, in order.
 */
export function toolPairsOf(prompt: readonly unknown[]): { calls: string[]; results: string[] } {
  const calls: string[] = [];
  const results: string[] = [];
  for (const message of prompt as Array<{ content: unknown }>) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{ type: string; toolCallId?: string }>) {
      if (part.type === "tool-call" && part.toolCallId !== undefined) calls.push(part.toolCallId);
      if (part.type === "tool-result" && part.toolCallId !== undefined) results.push(part.toolCallId);
    }
  }
  return { calls, results };
}

/**
 * The system text one request carried.
 * @param prompt - What one model call was handed.
 * @returns Its system messages, joined.
 */
export function systemOf(prompt: readonly unknown[] | undefined): string {
  return (prompt ?? [])
    .filter((m): m is { role: "system"; content: string } => (m as { role?: string }).role === "system")
    .map((m) => m.content)
    .join("\n");
}
