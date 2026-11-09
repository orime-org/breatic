// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `model.local` outbound relay of the web-animation container (inner#1711 design §6, DD §3.1).
 *
 * Every process in the container can reach `model.local`, so the relay, not the harness, decides what reaches
 * OpenRouter: it rebuilds the body from a field allowlist, forces a stream, clamps `max_tokens`, pins the model,
 * forwards one header and our key, rewrites DeepSeek's `thinking` form, strips the null usage counters dsh rejects,
 * and records each call against the job's Durable Object: one call in flight, every begun call ended exactly once.
 *
 * The relay is a plain function so these cases run on Node: the container class wires it to its outbound handler with
 * the job's limits and its own Durable Object as the registry. The upstream is a fetch stand-in; what OpenRouter
 * really answers was measured in the DD probe, and the sample events below are copied from that run's usage.
 */

import fc from "fast-check";
import { describe, expect, it, vi, type Mock } from "vitest";

import {
  MODEL_HOST,
  OPENROUTER_MESSAGES_URL,
  relayModelCall,
  type ModelCallEnd,
  type ModelRelayDeps,
} from "@ingest/jobs/web-animation-model-relay.js";

const API_KEY = "test-openrouter-key";
const MODEL = "deepseek/deepseek-v4.1-flash-1017";
const MAX_TOKENS = 32_000;

/** The fields the relay keeps, by the design's allowlist. */
const ALLOWED = [
  "model", "messages", "system", "tools", "tool_choice", "max_tokens", "stream", "thinking", "output_config",
  "temperature", "top_p", "stop_sequences", "metadata",
];

/** message_start as OpenRouter sent it in the probe: unknown counters are null. */
const MESSAGE_START = {
  type: "message_start",
  message: {
    id: "gen-1762500000-abc",
    type: "message",
    role: "assistant",
    content: [],
    model: MODEL,
    usage: {
      input_tokens: 0, output_tokens: 0, output_tokens_details: null, cache_creation_input_tokens: null,
      cache_read_input_tokens: null, cache_creation: null, server_tool_use: null, service_tier: null, speed: "standard",
    },
  },
};

const CONTENT_DELTA = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } };

/** message_delta as OpenRouter sent it in the probe: the final counters and the cost in dollars. */
const MESSAGE_DELTA = {
  type: "message_delta",
  delta: { stop_reason: "end_turn", stop_sequence: null },
  usage: {
    input_tokens: 41, output_tokens: 6, output_tokens_details: { thinking_tokens: 3 }, cache_creation_input_tokens: null,
    cache_read_input_tokens: 128, cache_creation: null, server_tool_use: null, service_tier: null, speed: "standard",
    cost: 0.000005838, is_byok: false,
  },
};

const MESSAGE_STOP = { type: "message_stop" };

/**
 * One SSE event as two lines.
 * @param event - The event body.
 * @returns Its wire text.
 */
function sse(event: { type: string }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const COMPLETE_STREAM = [MESSAGE_START, CONTENT_DELTA, MESSAGE_DELTA, MESSAGE_STOP].map(sse).join("");

/**
 * A stream of the given chunks, optionally failing or hanging after them.
 * @param chunks - Text chunks to send.
 * @param after - What happens after the last chunk.
 * @param signal - Aborts a hanging stream.
 * @returns The stream.
 */
function streamOf(chunks: string[], after: "close" | "error" | "hang" = "close", signal?: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let next = 0;
  // Chunks are handed out on pull: erroring a stream discards what is still queued, so a break must come after the
  // reader has taken every chunk.
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
    },
    pull(controller) {
      if (next < chunks.length) {
        controller.enqueue(encoder.encode(chunks[next]));
        next += 1;
        return undefined;
      }
      if (after === "close") controller.close();
      if (after === "error") controller.error(new Error("upstream connection reset"));
      // "hang": never answer this pull; only the abort above ends the stream.
      return after === "hang" ? new Promise<void>(() => undefined) : undefined;
    },
  }, { highWaterMark: 0 });
}

/**
 * An upstream answer streaming the given chunks.
 * @param chunks - Text chunks.
 * @param after - What happens after them.
 * @param signal - Aborts a hanging stream.
 * @returns The response.
 */
function upstreamStream(chunks: string[], after: "close" | "error" | "hang" = "close", signal?: AbortSignal): Response {
  return new Response(streamOf(chunks, after, signal), { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A recording registry and fetch. */
interface Harness {
  deps: ModelRelayDeps;
  beginModelCall: Mock<() => Promise<number | null>>;
  recordModelCallStart: Mock<(seq: number, generationId: string) => Promise<void>>;
  endModelCall: Mock<(seq: number, end: ModelCallEnd) => Promise<void>>;
  fetch: Mock<(url: string, init: RequestInit) => Promise<Response>>;
}

/**
 * Relay dependencies with a recording registry.
 * @param upstream - What the fake OpenRouter answers.
 * @param overrides - Limits or a begin answer to change.
 * @returns The harness.
 */
function harness(
  upstream: (url: string, init: RequestInit) => Promise<Response>,
  overrides: { seq?: number | null; callTimeoutMs?: number } = {},
): Harness {
  const beginModelCall = vi.fn(async (): Promise<number | null> => (overrides.seq === undefined ? 7 : overrides.seq));
  const recordModelCallStart = vi.fn(async (_seq: number, _generationId: string): Promise<void> => undefined);
  const endModelCall = vi.fn(async (_seq: number, _end: ModelCallEnd): Promise<void> => undefined);
  const fetch = vi.fn(upstream);
  return {
    beginModelCall,
    recordModelCallStart,
    endModelCall,
    fetch,
    deps: {
      apiKey: API_KEY,
      model: MODEL,
      maxTokens: MAX_TOKENS,
      callTimeoutMs: overrides.callTimeoutMs ?? 60_000,
      registry: { beginModelCall, recordModelCallStart, endModelCall },
      fetch,
    },
  };
}

/**
 * A request the harness sends to the relay.
 * @param body - The JSON body.
 * @param init - Method, path, headers or signal to change.
 * @returns The request.
 */
function harnessRequest(
  body: unknown,
  init: { method?: string; path?: string; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Request {
  const method = init.method ?? "POST";
  return new Request(`http://${MODEL_HOST}${init.path ?? "/v1/messages"}`, {
    method,
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...init.headers },
    ...(method !== "GET" && method !== "HEAD" && { body: typeof body === "string" ? body : JSON.stringify(body) }),
    ...(init.signal && { signal: init.signal }),
  });
}

const BODY = {
  model: "deepseek-flash",
  messages: [{ role: "user", content: "Write index.html" }],
  max_tokens: 4_000,
  stream: true,
};

/**
 * The JSON body the relay sent upstream.
 * @param h - The harness.
 * @returns The parsed body.
 */
function sentBody(h: Harness): Record<string, unknown> {
  const init = h.fetch.mock.calls[0]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

/**
 * The parsed `data:` events of a relayed stream.
 * @param text - The relayed text.
 * @returns The events.
 */
function dataEvents(text: string): Array<Record<string, unknown>> {
  return text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

/**
 * Read a relayed response to its end, swallowing a stream error the relay passed on.
 * @param res - The relayed response.
 * @returns The text read before the end or the error.
 */
async function drain(res: Response): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // An upstream failure mid-stream reaches the harness as a broken stream; what was read stays.
  }
  return text;
}

describe("relayModelCall: what reaches OpenRouter", () => {
  it("sends one POST to OpenRouter's Messages endpoint with our key", async () => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    await drain(await relayModelCall(harnessRequest(BODY), h.deps));

    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/messages");
    expect(OPENROUTER_MESSAGES_URL).toBe("https://openrouter.ai/api/v1/messages");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("forwards anthropic-version and drops every other header the harness sent", async () => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    await drain(await relayModelCall(harnessRequest(BODY, {
      headers: {
        authorization: "Bearer sk-placeholder",
        "x-api-key": "sk-placeholder",
        "anthropic-beta": "tool-addition-2026-01-01",
        "x-deepseek-harness-session": "session-1",
        "x-deepseek-harness-turn": "3",
        cookie: "a=b",
        "user-agent": "dsh/0.2.2",
      },
    }), h.deps));

    const headers = new Headers(h.fetch.mock.calls[0]![1].headers);
    expect([...headers.keys()].sort()).toEqual(["anthropic-version", "authorization", "content-type"]);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("rebuilds the body from the allowlist, dropping dsh_session_log and every other field", async () => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    const body = {
      model: "deepseek-flash",
      messages: [{ role: "user", content: "Write index.html" }],
      system: [{ type: "text", text: "You write web animations." }],
      tools: [{ name: "bash", description: "Run a command", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
      max_tokens: 4_000,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 2_000 },
      output_config: { effort: "high" },
      temperature: 0.7,
      top_p: 0.9,
      stop_sequences: ["</done>"],
      metadata: { user_id: "job" },
      dsh_session_log: { entries: ["the whole conversation"] },
      betas: ["tool-addition"],
      tool_addition: [{ name: "extra" }],
      unknown_extension: true,
    };
    await drain(await relayModelCall(harnessRequest(body), h.deps));

    const sent = sentBody(h);
    expect(Object.keys(sent).sort()).toEqual([...ALLOWED].sort());
    expect(sent).not.toHaveProperty("dsh_session_log");
    expect(sent["messages"]).toEqual(body.messages);
    expect(sent["system"]).toEqual(body.system);
    expect(sent["tools"]).toEqual(body.tools);
    expect(sent["tool_choice"]).toEqual(body.tool_choice);
    expect(sent["output_config"]).toEqual({ effort: "high" });
    expect(sent["temperature"]).toBe(0.7);
    expect(sent["top_p"]).toBe(0.9);
    expect(sent["stop_sequences"]).toEqual(["</done>"]);
    expect(sent["metadata"]).toEqual({ user_id: "job" });
  });

  it("only keeps allowlisted fields the harness actually sent", async () => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    await drain(await relayModelCall(harnessRequest({ ...BODY, dsh_session_log: "x" }), h.deps));

    expect(Object.keys(sentBody(h)).sort()).toEqual(["max_tokens", "messages", "model", "stream"]);
  });

  it("replaces the model the harness named with the job's model", async () => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    await drain(await relayModelCall(harnessRequest({ ...BODY, model: "deepseek-flash" }), h.deps));

    expect(sentBody(h)["model"]).toBe(MODEL);
  });

  it.each([
    ["false", false],
    ["absent", undefined],
  ])("forces stream to true when the harness sent it %s", async (_label, stream) => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    const body: Record<string, unknown> = { ...BODY };
    if (stream === undefined) delete body["stream"];
    else body["stream"] = stream;
    await drain(await relayModelCall(harnessRequest(body), h.deps));

    expect(sentBody(h)["stream"]).toBe(true);
  });

  it.each([
    ["above the job's limit", 64_000, MAX_TOKENS],
    ["at the job's limit", MAX_TOKENS, MAX_TOKENS],
    ["below the job's limit", 1_000, 1_000],
    ["absent", undefined, MAX_TOKENS],
  ])("sends max_tokens no higher than the job's maxTokens when the harness's is %s", async (_label, asked, expected) => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    const body: Record<string, unknown> = { ...BODY };
    if (asked === undefined) delete body["max_tokens"];
    else body["max_tokens"] = asked;
    await drain(await relayModelCall(harnessRequest(body), h.deps));

    expect(sentBody(h)["max_tokens"]).toBe(expected);
  });

  it("rewrites thinking enabled without budget_tokens to adaptive and keeps output_config.effort", async () => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    await drain(await relayModelCall(harnessRequest({ ...BODY, thinking: { type: "enabled" }, output_config: { effort: "max" } }), h.deps));

    expect(sentBody(h)["thinking"]).toEqual({ type: "adaptive" });
    expect(sentBody(h)["output_config"]).toEqual({ effort: "max" });
  });

  it("leaves thinking that already carries budget_tokens, or is disabled, as it is", async () => {
    for (const thinking of [{ type: "enabled", budget_tokens: 2_048 }, { type: "disabled" }]) {
      const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
      await drain(await relayModelCall(harnessRequest({ ...BODY, thinking }), h.deps));
      expect(sentBody(h)["thinking"]).toEqual(thinking);
    }
  });
});

describe("relayModelCall: what reaches the harness", () => {
  it("answers with OpenRouter's status and event-stream type", async () => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    const res = await relayModelCall(harnessRequest(BODY), h.deps);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await drain(res);
  });

  it("deletes usage counters whose value is null and passes every other event through", async () => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    const text = await drain(await relayModelCall(harnessRequest(BODY), h.deps));

    const events = dataEvents(text);
    expect(events.map((event) => event["type"])).toEqual(["message_start", "content_block_delta", "message_delta", "message_stop"]);
    const startUsage = (events[0]!["message"] as { usage: Record<string, unknown> }).usage;
    expect(startUsage).toEqual({ input_tokens: 0, output_tokens: 0, speed: "standard" });
    const deltaUsage = events[2]!["usage"] as Record<string, unknown>;
    expect(deltaUsage).toEqual({
      input_tokens: 41, output_tokens: 6, output_tokens_details: { thinking_tokens: 3 }, cache_read_input_tokens: 128,
      speed: "standard", cost: 0.000005838, is_byok: false,
    });
    expect(events[1]).toEqual(CONTENT_DELTA);
    expect(events[3]).toEqual(MESSAGE_STOP);
    // Non-data lines of the stream are untouched.
    expect(text.split("\n").filter((line) => line.startsWith("event: "))).toEqual([
      "event: message_start", "event: content_block_delta", "event: message_delta", "event: message_stop",
    ]);
  });

  it("strips null counters the same way wherever the upstream splits its chunks", async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: COMPLETE_STREAM.length - 1 }), { maxLength: 12 }),
      async (cuts) => {
        const points = [0, ...[...cuts].sort((a, b) => a - b), COMPLETE_STREAM.length];
        const chunks = points.slice(1).map((end, i) => COMPLETE_STREAM.slice(points[i], end));
        const h = harness(async () => upstreamStream(chunks));
        const events = dataEvents(await drain(await relayModelCall(harnessRequest(BODY), h.deps)));

        expect(events).toHaveLength(4);
        const startUsage = (events[0]!["message"] as { usage: Record<string, unknown> }).usage;
        expect(Object.values(startUsage)).not.toContain(null);
        expect(Object.values(events[2]!["usage"] as Record<string, unknown>)).not.toContain(null);
      },
    ), { numRuns: 60 });
  });
});

describe("relayModelCall: which requests it takes", () => {
  it.each([
    ["GET /v1/messages", "GET", "/v1/messages"],
    ["POST /v1/complete", "POST", "/v1/complete"],
    ["POST /v1/messages/count_tokens", "POST", "/v1/messages/count_tokens"],
    ["POST /", "POST", "/"],
  ])("refuses %s without beginning a call or reaching OpenRouter", async (_label, method, path) => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    const res = await relayModelCall(harnessRequest(BODY, { method, path }), h.deps);

    expect(res.status).toBe(403);
    expect(h.beginModelCall).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not a JSON object, without beginning a call", async () => {
    for (const body of ["not json", "[1,2]", "null"]) {
      const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
      const res = await relayModelCall(harnessRequest(body), h.deps);

      expect(res.status).toBe(400);
      expect(h.beginModelCall).not.toHaveBeenCalled();
      expect(h.fetch).not.toHaveBeenCalled();
    }
  });

  it("answers 409 without reaching OpenRouter when the job refuses to begin a call", async () => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]), { seq: null });
    const res = await relayModelCall(harnessRequest(BODY), h.deps);

    expect(res.status).toBe(409);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.endModelCall).not.toHaveBeenCalled();
  });
});

describe("relayModelCall: recording the call", () => {
  it("records the generation id from message_start and ends the call completed with message_delta's counters and cost", async () => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    await drain(await relayModelCall(harnessRequest(BODY), h.deps));

    await vi.waitFor(() => expect(h.endModelCall).toHaveBeenCalledTimes(1));
    expect(h.recordModelCallStart).toHaveBeenCalledWith(7, "gen-1762500000-abc");
    expect(h.endModelCall).toHaveBeenCalledWith(7, {
      outcome: "completed",
      tokens: { input: 41, output: 6, reasoning: 3, cacheRead: 128 },
      costUsd: 0.000005838,
    });
  });

  it("counts a missing thinking or cache counter as zero", async () => {
    const delta = { ...MESSAGE_DELTA, usage: { input_tokens: 10, output_tokens: 2, cost: 0.0001 } };
    const h = harness(async () => upstreamStream([[MESSAGE_START, delta, MESSAGE_STOP].map(sse).join("")]));
    await drain(await relayModelCall(harnessRequest(BODY), h.deps));

    await vi.waitFor(() => expect(h.endModelCall).toHaveBeenCalledTimes(1));
    expect(h.endModelCall).toHaveBeenCalledWith(7, {
      outcome: "completed", tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0 }, costUsd: 0.0001,
    });
  });

  it.each([429, 500, 503])("passes an upstream %i through to the harness and ends the call upstream_error", async (status) => {
    const h = harness(async () => new Response(JSON.stringify({ error: { message: "busy" } }), {
      status, headers: { "content-type": "application/json" },
    }));
    const res = await relayModelCall(harnessRequest(BODY), h.deps);

    expect(res.status).toBe(status);
    await drain(res);
    await vi.waitFor(() => expect(h.endModelCall).toHaveBeenCalledTimes(1));
    expect(h.endModelCall).toHaveBeenCalledWith(7, { outcome: "upstream_error", tokens: null, costUsd: null });
    expect(h.recordModelCallStart).not.toHaveBeenCalled();
  });

  it("answers 502 and ends the call upstream_error when the fetch to OpenRouter fails", async () => {
    const h = harness(async () => {
      throw new TypeError("fetch failed");
    });
    const res = await relayModelCall(harnessRequest(BODY), h.deps);

    expect(res.status).toBe(502);
    await vi.waitFor(() => expect(h.endModelCall).toHaveBeenCalledTimes(1));
    expect(h.endModelCall).toHaveBeenCalledWith(7, { outcome: "upstream_error", tokens: null, costUsd: null });
  });

  it("ends the call interrupted when the stream breaks after message_start", async () => {
    const h = harness(async () => upstreamStream([sse(MESSAGE_START), sse(CONTENT_DELTA)], "error"));
    await drain(await relayModelCall(harnessRequest(BODY), h.deps));

    await vi.waitFor(() => expect(h.endModelCall).toHaveBeenCalledTimes(1));
    expect(h.recordModelCallStart).toHaveBeenCalledWith(7, "gen-1762500000-abc");
    expect(h.endModelCall.mock.calls[0]![1].outcome).toBe("interrupted");
    expect(h.endModelCall.mock.calls[0]![1].costUsd).toBeNull();
  });

  it("ends the call interrupted when the stream closes after message_start but before message_delta", async () => {
    const h = harness(async () => upstreamStream([sse(MESSAGE_START), sse(CONTENT_DELTA)], "close"));
    await drain(await relayModelCall(harnessRequest(BODY), h.deps));

    await vi.waitFor(() => expect(h.endModelCall).toHaveBeenCalledTimes(1));
    expect(h.endModelCall.mock.calls[0]![1].outcome).toBe("interrupted");
  });

  it("ends the call upstream_error when a 200 stream closes or breaks before message_start", async () => {
    for (const after of ["close", "error"] as const) {
      const h = harness(async () => upstreamStream([": keep-alive\n\n"], after));
      await drain(await relayModelCall(harnessRequest(BODY), h.deps));

      await vi.waitFor(() => expect(h.endModelCall).toHaveBeenCalledTimes(1));
      expect(h.endModelCall).toHaveBeenCalledWith(7, { outcome: "upstream_error", tokens: null, costUsd: null });
    }
  });

  it("aborts the upstream request and ends the call interrupted when the harness abandons its request", async () => {
    const abandon = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const h = harness(async (_url, init) => {
      upstreamSignal = init.signal ?? undefined;
      return upstreamStream([sse(MESSAGE_START)], "hang", upstreamSignal);
    });
    const res = await relayModelCall(harnessRequest(BODY, { signal: abandon.signal }), h.deps);
    const reading = drain(res);
    await vi.waitFor(() => expect(h.recordModelCallStart).toHaveBeenCalled());
    abandon.abort();
    await reading;

    await vi.waitFor(() => expect(h.endModelCall).toHaveBeenCalledTimes(1));
    expect(upstreamSignal?.aborted).toBe(true);
    expect(h.endModelCall.mock.calls[0]![1].outcome).toBe("interrupted");
  });

  it("aborts a call that outlives callTimeoutMs after message_start and ends it interrupted", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const h = harness(async (_url, init) => {
      upstreamSignal = init.signal ?? undefined;
      return upstreamStream([sse(MESSAGE_START)], "hang", upstreamSignal);
    }, { callTimeoutMs: 50 });
    await drain(await relayModelCall(harnessRequest(BODY), h.deps));

    await vi.waitFor(() => expect(h.endModelCall).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(upstreamSignal?.aborted).toBe(true);
    expect(h.endModelCall.mock.calls[0]![1].outcome).toBe("interrupted");
  });

  it("aborts a call whose upstream never answers within callTimeoutMs and ends it upstream_error", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const h = harness((_url, init) => new Promise<Response>((_resolve, reject) => {
      upstreamSignal = init.signal ?? undefined;
      upstreamSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }), { callTimeoutMs: 50 });
    const res = await relayModelCall(harnessRequest(BODY), h.deps);

    expect(res.status).toBeGreaterThanOrEqual(500);
    await vi.waitFor(() => expect(h.endModelCall).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(upstreamSignal?.aborted).toBe(true);
    expect(h.endModelCall).toHaveBeenCalledWith(7, { outcome: "upstream_error", tokens: null, costUsd: null });
  });

  it("ends every begun call exactly once, with the seq it began under", async () => {
    const answers: Array<() => Promise<Response>> = [
      async () => upstreamStream([COMPLETE_STREAM]),
      async () => new Response("busy", { status: 429 }),
      async () => upstreamStream([sse(MESSAGE_START)], "error"),
      async () => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const answer of answers) {
      const h = harness(answer, { seq: 3 });
      await drain(await relayModelCall(harnessRequest(BODY), h.deps));
      await vi.waitFor(() => expect(h.endModelCall).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(h.beginModelCall).toHaveBeenCalledTimes(1);
      expect(h.endModelCall).toHaveBeenCalledTimes(1);
      expect(h.endModelCall.mock.calls[0]![0]).toBe(3);
    }
  });
});
