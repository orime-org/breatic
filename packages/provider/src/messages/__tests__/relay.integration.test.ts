// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Messages relay of the web-animation container, run on Node against loopback upstreams. The stream samples are
 * the events OpenRouter sent in the inner#1711 probe (unknown usage counters null, the cost on message_delta).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { relayMessages, type MessagesCallEnd, type MessagesCandidate, type MessagesPlan } from "../relay.js";
import { startFakes, stopFakes, type LlmFakes } from "../../llm/__tests__/llm-harness.js";

let fakes: LlmFakes;

beforeEach(async () => {
  fakes = await startFakes();
});

afterEach(async () => {
  await stopFakes(fakes);
});

const MESSAGE_START = {
  type: "message_start",
  message: {
    id: "gen-1762500000-abc", type: "message", role: "assistant", content: [], model: "deepseek/deepseek-v4-pro",
    usage: { input_tokens: 0, output_tokens: 0, output_tokens_details: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, speed: "standard" },
  },
};
const CONTENT_DELTA = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } };
const MESSAGE_DELTA = {
  type: "message_delta",
  delta: { stop_reason: "end_turn", stop_sequence: null },
  usage: { input_tokens: 41, output_tokens: 6, output_tokens_details: { thinking_tokens: 3 }, cache_creation_input_tokens: null, cache_read_input_tokens: 128, cost: 0.000005838 },
};
const MESSAGE_STOP = { type: "message_stop" };

/** One event of a Messages stream. */
type SseEvent = { type: string } & Record<string, unknown>;

/**
 * One SSE event as its two lines.
 * @param event - The event.
 * @returns Its wire text.
 */
const sse = (event: SseEvent): string => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/**
 * A 200 event stream of the given events.
 * @param events - The events.
 * @param end - How the body ends: whole, cut after the events, or held open.
 * @returns The reply.
 */
const stream = (events: SseEvent[], end: "whole" | "cut" | "hold" = "whole"): { status: number; raw: string; contentType: string; cut?: boolean; hold?: boolean } => ({
  status: 200,
  raw: events.map(sse).join(""),
  contentType: "text/event-stream",
  ...(end === "cut" ? { cut: true } : end === "hold" ? { hold: true } : {}),
});

const COMPLETE = [MESSAGE_START, CONTENT_DELTA, MESSAGE_DELTA, MESSAGE_STOP];
const DIRECT_PRICES: NonNullable<MessagesCandidate["prices"]> = [{ input_cache_hit_per_mtok: 0.044, input_cache_miss_per_mtok: 1.32, output_per_mtok: 3.96 }];

/**
 * The candidates of a plan, by kind, over the fakes.
 * @returns One candidate of each kind.
 */
const candidates = (): Record<"openrouter" | "anthropic" | "deepseek", MessagesCandidate> => ({
  openrouter: { upstream: "openrouter", kind: "openrouter", baseUrl: `${fakes.openrouter.url}/api/v1`, vendorModel: "deepseek/deepseek-v4-pro", keyEnv: "OPENROUTER_API_KEY" },
  anthropic: { upstream: "anthropic", kind: "anthropic", baseUrl: fakes.anthropic.url, vendorModel: "claude-opus-5-5", keyEnv: "ANTHROPIC_API_KEY", prices: DIRECT_PRICES },
  deepseek: { upstream: "deepseek", kind: "deepseek", baseUrl: fakes.deepseek.url, vendorModel: "deepseek-v4-pro", keyEnv: "DEEPSEEK_API_KEY", prices: DIRECT_PRICES },
});

const BODY = { model: "deepseek-flash", messages: [{ role: "user", content: "Write index.html" }], max_tokens: 4_000, stream: true };
const KEYS: Record<string, string> = { OPENROUTER_API_KEY: "or-key", ANTHROPIC_API_KEY: "an-key", DEEPSEEK_API_KEY: "ds-key" };

/** What one relayed call reported. */
interface Relayed {
  response: Response;
  started: { upstream: string; messageId: string }[];
  ended: MessagesCallEnd[];
  /** Events in the order they happened, the stream's end included. */
  order: string[];
}

/**
 * Relay one call and read the answer to its end.
 * @param plan - The plan.
 * @param body - The harness's body.
 * @param options - Keys, limits, signal or headers to change.
 * @param options.keys - The keys the Worker has.
 * @param options.maxTokens - The job's limit.
 * @param options.signal - The call's signal.
 * @param options.anthropicVersion - The header the harness sent.
 * @returns What happened.
 */
async function relay(
  plan: MessagesPlan,
  body: Record<string, unknown> = BODY,
  options: { keys?: Record<string, string>; maxTokens?: number; signal?: AbortSignal; anthropicVersion?: string } = {},
): Promise<Relayed & { text: string }> {
  const started: Relayed["started"] = [];
  const ended: MessagesCallEnd[] = [];
  const order: string[] = [];
  const response = await relayMessages(plan, body, {
    keyOf: (name) => (options.keys ?? KEYS)[name],
    maxTokens: options.maxTokens ?? 32_000,
    signal: options.signal ?? new AbortController().signal,
    ...(options.anthropicVersion === undefined ? {} : { anthropicVersion: options.anthropicVersion }),
    onStarted: async (upstream, messageId) => {
      started.push({ upstream, messageId });
      order.push("started");
    },
    onEnded: async (end) => {
      await new Promise((done) => setTimeout(done, 20));
      ended.push(end);
      order.push("ended");
    },
  });
  let text = "";
  if (response.body !== null) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // A break mid-stream reaches the harness as a broken stream; what was read stays.
    }
  }
  order.push("closed");
  return { response, started, ended, order, text };
}

/**
 * The JSON body an upstream received.
 * @param fake - The upstream.
 * @returns Its last POST body.
 */
const received = (fake: LlmFakes[keyof LlmFakes]): Record<string, unknown> => fake.seen.filter((s) => s.method === "POST").at(-1)!.body as Record<string, unknown>;

/**
 * The parsed data events of a relayed stream.
 * @param text - The relayed text.
 * @returns The events.
 */
const dataEvents = (text: string): Record<string, unknown>[] => text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);

describe("relayMessages: what reaches each upstream", () => {
  it("sends OpenRouter's Messages endpoint our key and the harness's anthropic-version, and nothing else of the harness", async () => {
    fakes.openrouter.answer(() => stream(COMPLETE));
    await relay({ model: "deepseek/deepseek-v4-pro", candidates: [candidates().openrouter] }, BODY, { anthropicVersion: "2023-06-01" });
    const seen = fakes.openrouter.seen.filter((s) => s.method === "POST");
    expect(seen.map((s) => s.path)).toEqual(["/api/v1/messages"]);
    expect(seen[0]!.headers["authorization"]).toBe("Bearer or-key");
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen[0]!.headers).not.toHaveProperty("x-api-key");
  });

  it("sends Anthropic its key as x-api-key at its Messages endpoint", async () => {
    fakes.anthropic.answer(() => stream(COMPLETE));
    await relay({ model: "anthropic/claude-opus-5.5", candidates: [candidates().anthropic] }, BODY, { anthropicVersion: "2023-06-01" });
    const seen = fakes.anthropic.seen.filter((s) => s.method === "POST");
    expect(seen.map((s) => s.path)).toEqual(["/messages"]);
    expect(seen[0]!.headers["x-api-key"]).toBe("an-key");
    expect(seen[0]!.headers).not.toHaveProperty("authorization");
    expect(received(fakes.anthropic)["model"]).toBe("claude-opus-5-5");
  });

  it("sends DeepSeek its key as x-api-key at its Anthropic-compatible endpoint", async () => {
    fakes.deepseek.answer(() => stream(COMPLETE));
    await relay({ model: "deepseek/deepseek-v4-pro", candidates: [candidates().deepseek] });
    const seen = fakes.deepseek.seen.filter((s) => s.method === "POST");
    expect(seen.map((s) => s.path)).toEqual(["/anthropic/v1/messages"]);
    expect(seen[0]!.headers["x-api-key"]).toBe("ds-key");
  });

  it("rebuilds the body from the allowlist, with the candidate's model and a forced stream", async () => {
    fakes.openrouter.answer(() => stream(COMPLETE));
    const body = {
      ...BODY, system: [{ type: "text", text: "x" }], tools: [{ name: "bash" }], tool_choice: { type: "auto" }, thinking: { type: "enabled", budget_tokens: 2_000 },
      output_config: { effort: "high" }, temperature: 0.7, top_p: 0.9, stop_sequences: ["</done>"], metadata: { user_id: "job" },
      stream: false, dsh_session_log: { entries: [] }, betas: ["x"], unknown_extension: true,
    };
    await relay({ model: "deepseek/deepseek-v4-pro", candidates: [candidates().openrouter] }, body);
    const sent = received(fakes.openrouter);
    expect(Object.keys(sent).sort()).toEqual(["max_tokens", "messages", "metadata", "model", "output_config", "stop_sequences", "stream", "system", "temperature", "thinking", "tool_choice", "tools", "top_p"]);
    expect(sent["model"]).toBe("deepseek/deepseek-v4-pro");
    expect(sent["stream"]).toBe(true);
  });

  it.each([
    ["above the job's limit", 64_000, 32_000],
    ["at the job's limit", 32_000, 32_000],
    ["below the job's limit", 1_000, 1_000],
    ["absent", undefined, 32_000],
  ])("sends max_tokens no higher than the job's limit when the harness's is %s", async (_label, asked, expected) => {
    fakes.openrouter.answer(() => stream(COMPLETE));
    const body: Record<string, unknown> = { ...BODY, max_tokens: asked };
    if (asked === undefined) delete body["max_tokens"];
    await relay({ model: "deepseek/deepseek-v4-pro", candidates: [candidates().openrouter] }, body);
    expect(received(fakes.openrouter)["max_tokens"]).toBe(expected);
  });

  it("rewrites thinking enabled without a budget to adaptive for OpenRouter only", async () => {
    fakes.openrouter.answer(() => stream(COMPLETE));
    fakes.anthropic.answer(() => stream(COMPLETE));
    await relay({ model: "m", candidates: [candidates().openrouter] }, { ...BODY, thinking: { type: "enabled" } });
    await relay({ model: "m", candidates: [candidates().anthropic] }, { ...BODY, thinking: { type: "enabled" } });
    expect(received(fakes.openrouter)["thinking"]).toEqual({ type: "adaptive" });
    expect(received(fakes.anthropic)["thinking"]).toEqual({ type: "enabled" });
  });
});

describe("relayMessages: which upstream serves", () => {
  it("skips a candidate whose key the Worker lacks", async () => {
    fakes.openrouter.answer(() => stream(COMPLETE));
    const { started } = await relay({ model: "m", candidates: [candidates().deepseek, candidates().openrouter] }, BODY, { keys: { OPENROUTER_API_KEY: "or-key" } });
    expect(fakes.deepseek.seen).toHaveLength(0);
    expect(started).toEqual([{ upstream: "openrouter", messageId: "gen-1762500000-abc" }]);
  });

  it.each([
    ["says its balance is too low", { status: 402, body: { error: { message: "Insufficient Balance" } } }],
    ["is busy", { status: 503, body: { error: { message: "busy" } } }],
  ])("moves on when the first upstream %s", async (_label, reply) => {
    fakes.deepseek.answer(() => reply);
    fakes.openrouter.answer(() => stream(COMPLETE));
    const { response, started } = await relay({ model: "m", candidates: [candidates().deepseek, candidates().openrouter] });
    expect(response.status).toBe(200);
    expect(started[0]!.upstream).toBe("openrouter");
  });

  it("moves on when an upstream says it has no such model", async () => {
    fakes.openrouter.answer(() => ({ status: 400, body: { error: { message: "deepseek/x is not a valid model ID" } } }));
    fakes.anthropic.answer(() => stream(COMPLETE));
    const { started } = await relay({ model: "m", candidates: [candidates().openrouter, candidates().anthropic] });
    expect(started[0]!.upstream).toBe("anthropic");
  });

  it("moves on when an upstream cannot be reached", async () => {
    const plan = { model: "m", candidates: [candidates().deepseek, candidates().openrouter] };
    await fakes.deepseek.close();
    fakes.openrouter.answer(() => stream(COMPLETE));
    const { started } = await relay(plan);
    expect(started[0]!.upstream).toBe("openrouter");
  });

  it("passes any other refusal through and moves on nowhere", async () => {
    fakes.deepseek.answer(() => ({ status: 400, body: { error: { message: "bad request" } } }));
    const { response, ended } = await relay({ model: "m", candidates: [candidates().deepseek, candidates().openrouter] });
    expect(response.status).toBe(400);
    expect(fakes.openrouter.seen).toHaveLength(0);
    expect(ended).toEqual([{ outcome: "upstream_error", upstream: null, tokens: null, cost: null }]);
  });

  it("passes the last upstream's answer through when every one is busy", async () => {
    fakes.deepseek.answer(() => ({ status: 503, body: { error: { message: "busy" } } }));
    fakes.openrouter.answer(() => ({ status: 503, body: { error: { message: "busy" } } }));
    const { response, ended } = await relay({ model: "m", candidates: [candidates().deepseek, candidates().openrouter] });
    expect(response.status).toBe(503);
    expect(ended).toEqual([{ outcome: "upstream_error", upstream: null, tokens: null, cost: null }]);
  });

  it("answers 502 when no candidate could be reached or none has a key", async () => {
    const { response, ended } = await relay({ model: "m", candidates: [candidates().deepseek] }, BODY, { keys: {} });
    expect(response.status).toBe(502);
    expect(ended).toEqual([{ outcome: "upstream_error", upstream: null, tokens: null, cost: null }]);
  });
});

describe("relayMessages: what reaches the harness, and how the call ends", () => {
  it("deletes null usage counters and passes every other line through", async () => {
    fakes.openrouter.answer(() => stream(COMPLETE));
    const { text, response } = await relay({ model: "m", candidates: [candidates().openrouter] });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = dataEvents(text);
    expect(events.map((e) => e["type"])).toEqual(["message_start", "content_block_delta", "message_delta", "message_stop"]);
    expect((events[0]!["message"] as { usage: Record<string, unknown> }).usage).toEqual({ input_tokens: 0, output_tokens: 0, speed: "standard" });
    expect(Object.values(events[2]!["usage"] as Record<string, unknown>)).not.toContain(null);
    expect(text.split("\n").filter((l) => l.startsWith("event: "))).toEqual(["event: message_start", "event: content_block_delta", "event: message_delta", "event: message_stop"]);
  });

  it("ends a call OpenRouter completed with its counters and its reported cost, before the stream closes", async () => {
    fakes.openrouter.answer(() => stream(COMPLETE));
    const { started, ended, order } = await relay({ model: "m", candidates: [candidates().openrouter] });
    expect(started).toEqual([{ upstream: "openrouter", messageId: "gen-1762500000-abc" }]);
    expect(ended).toEqual([{
      outcome: "completed",
      upstream: "openrouter",
      tokens: { input: 41, output: 6, reasoning: 3, cacheRead: 128 },
      cost: { state: "known", usd: 0.000005838, source: "reported", tokens: { input: 169, cachedInput: 128, output: 6, reasoning: 3 } },
    }]);
    expect(order).toEqual(["started", "ended", "closed"]);
  });

  it("leaves OpenRouter's cost pending by its generation when the stream carries none", async () => {
    const delta = { ...MESSAGE_DELTA, usage: { input_tokens: 10, output_tokens: 2 } };
    fakes.openrouter.answer(() => stream([MESSAGE_START, delta, MESSAGE_STOP]));
    const { ended } = await relay({ model: "m", candidates: [candidates().openrouter] });
    expect(ended[0]!.cost).toEqual({ state: "pending", lookup: { upstream: "openrouter", generationId: "gen-1762500000-abc" } });
    expect(ended[0]!.tokens).toEqual({ input: 10, output: 2, reasoning: 0, cacheRead: 0 });
  });

  it("prices a direct upstream's call from the plan's prices at the moment it was sent", async () => {
    fakes.deepseek.answer(() => stream(COMPLETE));
    const { ended } = await relay({ model: "m", candidates: [candidates().deepseek] });
    const usd = (41 * 1.32 + 128 * 0.044 + 6 * 3.96) / 1_000_000;
    expect(ended[0]!.cost).toEqual({ state: "known", usd, source: "price_table", tokens: { input: 169, cachedInput: 128, output: 6, reasoning: 3 } });
  });

  it("costs a direct upstream's call as missing when the plan carries no price", async () => {
    fakes.deepseek.answer(() => stream(COMPLETE));
    const { prices: _dropped, ...unpriced } = candidates().deepseek;
    const { ended } = await relay({ model: "m", candidates: [unpriced] });
    expect(ended[0]!.cost?.state).toBe("missing");
  });

  it("ends a call broken after message_start as interrupted: OpenRouter's pending by generation, a direct one missing", async () => {
    fakes.openrouter.answer(() => stream([MESSAGE_START, CONTENT_DELTA], "cut"));
    fakes.deepseek.answer(() => stream([MESSAGE_START, CONTENT_DELTA], "cut"));
    const viaGateway = await relay({ model: "m", candidates: [candidates().openrouter] });
    const direct = await relay({ model: "m", candidates: [candidates().deepseek] });
    expect(viaGateway.ended).toEqual([{ outcome: "interrupted", upstream: "openrouter", tokens: null, cost: { state: "pending", lookup: { upstream: "openrouter", generationId: "gen-1762500000-abc" } } }]);
    expect(direct.ended).toEqual([{ outcome: "interrupted", upstream: "deepseek", tokens: null, cost: expect.objectContaining({ state: "missing" }) }]);
  });

  it("ends a 200 stream that stops before message_start as an upstream error that cost nothing", async () => {
    fakes.openrouter.answer(() => ({ status: 200, raw: ": keep-alive\n\n", contentType: "text/event-stream" }));
    const { ended } = await relay({ model: "m", candidates: [candidates().openrouter] });
    expect(ended).toEqual([{ outcome: "upstream_error", upstream: null, tokens: null, cost: null }]);
  });

  it("ends a call its signal stopped after message_start as interrupted, once", async () => {
    fakes.openrouter.answer(() => stream([MESSAGE_START], "hold"));
    const stop = new AbortController();
    const relaying = relay({ model: "m", candidates: [candidates().openrouter] }, BODY, { signal: stop.signal });
    await new Promise((done) => setTimeout(done, 200));
    stop.abort();
    const { ended } = await relaying;
    fakes.openrouter.release();
    expect(ended).toHaveLength(1);
    expect(ended[0]!.outcome).toBe("interrupted");
  });
});

/**
 * A loopback upstream that writes its answer in the given pieces, with or without a content type.
 * @param pieces - The body, piece by piece, each written after a pause.
 * @param contentType - The content type, or none.
 * @returns Its base address and a way to close it.
 */
async function pieceByPiece(pieces: string[], contentType?: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, contentType === undefined ? {} : { "content-type": contentType });
      let i = 0;
      const next = (): void => {
        if (i >= pieces.length) {
          res.end();
          return;
        }
        res.write(pieces[i++]);
        setTimeout(next, 15);
      };
      next();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((done) => server.close(() => done())) };
}

describe("relayMessages: the stream's edges", () => {
  it("ends a call whose upstream took the request and never answered as an upstream error, moving on nowhere", async () => {
    fakes.deepseek.answer(() => "reset");
    fakes.openrouter.answer(() => stream(COMPLETE));
    const { response, ended } = await relay({ model: "m", candidates: [candidates().deepseek, candidates().openrouter] });
    expect(response.status).toBe(502);
    expect(fakes.openrouter.seen).toHaveLength(0);
    expect(ended).toEqual([{ outcome: "upstream_error", upstream: null, tokens: null, cost: null }]);
  });

  it("passes on lines split across chunks whole, the last one without its newline included", async () => {
    const text = COMPLETE.map(sse).join("").replace(/\n+$/, "");
    const cut = Math.floor(text.length / 2);
    const upstream = await pieceByPiece([text.slice(0, 7), text.slice(7, cut), text.slice(cut)], "text/event-stream");
    try {
      const { text: relayed, ended } = await relay({ model: "m", candidates: [{ ...candidates().openrouter, baseUrl: upstream.url }] });
      expect(dataEvents(relayed).map((e) => e["type"])).toEqual(["message_start", "content_block_delta", "message_delta", "message_stop"]);
      expect(ended[0]!.outcome).toBe("completed");
    } finally {
      await upstream.close();
    }
  });

  it("keeps CRLF line ends and passes data that is not a JSON object as it came", async () => {
    const body = [`data: ${JSON.stringify(MESSAGE_START)}\r\n`, "data: [DONE]\r\n", "data: 5\r\n", `data: ${JSON.stringify(MESSAGE_DELTA)}\r\n`].join("");
    const upstream = await pieceByPiece([body]);
    try {
      const { text, response, ended } = await relay({ model: "m", candidates: [{ ...candidates().openrouter, baseUrl: upstream.url }] });
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(text.split("\n").filter((l) => l !== "")).toEqual([
        `data: ${JSON.stringify({ ...MESSAGE_START, message: { ...MESSAGE_START.message, usage: { input_tokens: 0, output_tokens: 0, speed: "standard" } } })}\r`,
        "data: [DONE]\r",
        "data: 5\r",
        `data: ${JSON.stringify({ ...MESSAGE_DELTA, usage: { input_tokens: 41, output_tokens: 6, output_tokens_details: { thinking_tokens: 3 }, cache_read_input_tokens: 128, cost: 0.000005838 } })}\r`,
      ]);
      expect(ended[0]!.outcome).toBe("completed");
    } finally {
      await upstream.close();
    }
  });

  it("ends a call the caller stops reading as interrupted, once", async () => {
    fakes.openrouter.answer(() => stream([MESSAGE_START], "hold"));
    const ended: MessagesCallEnd[] = [];
    const response = await relayMessages({ model: "m", candidates: [candidates().openrouter] }, BODY, {
      keyOf: (name) => KEYS[name], maxTokens: 32_000, signal: new AbortController().signal,
      onStarted: async () => undefined,
      onEnded: async (end) => {
        ended.push(end);
      },
    });
    const reader = response.body!.getReader();
    await reader.read();
    const pending = reader.read();
    await reader.cancel("the harness left");
    await pending.catch(() => undefined);
    fakes.openrouter.release();
    await new Promise((done) => setTimeout(done, 50));
    expect(ended).toHaveLength(1);
    expect(ended[0]!.outcome).toBe("interrupted");
  });

  it("costs OpenRouter's call as missing when it names no generation and reports no cost", async () => {
    const start = { ...MESSAGE_START, message: { ...MESSAGE_START.message, id: "msg_1" } };
    fakes.openrouter.answer(() => stream([start, { ...MESSAGE_DELTA, usage: { input_tokens: 1, output_tokens: 1 } }, MESSAGE_STOP]));
    const { ended } = await relay({ model: "m", candidates: [candidates().openrouter] });
    expect(ended[0]!.cost).toEqual({ state: "missing", reason: expect.any(String) });
  });

  it("prices a direct call whose usage names no thinking, counting none", async () => {
    fakes.deepseek.answer(() => stream([MESSAGE_START, { ...MESSAGE_DELTA, usage: { input_tokens: 10, output_tokens: 2 } }, MESSAGE_STOP]));
    const { ended } = await relay({ model: "m", candidates: [candidates().deepseek] });
    expect(ended[0]!.cost).toEqual({ state: "known", usd: (10 * 1.32 + 2 * 3.96) / 1_000_000, source: "price_table", tokens: { input: 10, cachedInput: 0, output: 2, reasoning: 0 } });
  });
});
