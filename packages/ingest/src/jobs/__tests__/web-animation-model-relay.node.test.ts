// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `model.local` outbound relay of the web-animation container (inner#1711 design §6, DD §3.1).
 *
 * Every process in the container can reach `model.local`, so the relay, not the harness, decides what reaches a
 * model: it takes only `POST /v1/messages` with a JSON body, hands the call to provider's Messages relay along the
 * job's plan (which rebuilds the body, picks the upstream and reads the cost; its own tests cover those), and
 * records each call against the job's Durable Object: one call in flight, every begun call ended exactly once.
 *
 * The relay is a plain function so these cases run on Node: the container class wires it to its outbound handler with
 * the job's plan and limits and its own Durable Object as the registry. The upstream is a global fetch stand-in; the
 * sample events below are copied from what OpenRouter answered in the DD probe.
 */

import type { MessagesCallEnd, MessagesPlan } from "@breatic/provider/messages";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { MODEL_HOST, relayModelCall, type ModelRelayDeps } from "@ingest/jobs/web-animation-model-relay.js";

const API_KEY = "test-openrouter-key";
const MODEL = "deepseek/deepseek-v4.1-flash-1017";
const MAX_TOKENS = 32_000;

const PLAN: MessagesPlan = {
  model: MODEL,
  candidates: [{ upstream: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", vendorModel: MODEL, keyEnv: "OPENROUTER_API_KEY" }],
};

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
  recordModelCallStart: Mock<(seq: number, upstream: string, messageId: string) => Promise<void>>;
  endModelCall: Mock<(seq: number, end: MessagesCallEnd) => Promise<void>>;
  fetch: Mock<(url: string, init: RequestInit) => Promise<Response>>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Relay dependencies with a recording registry.
 * @param upstream - What the fake OpenRouter answers; it stands in for the global fetch provider sends with.
 * @param overrides - Limits or a begin answer to change.
 * @returns The harness.
 */
function harness(
  upstream: (url: string, init: RequestInit) => Promise<Response>,
  overrides: { seq?: number | null; callTimeoutMs?: number } = {},
): Harness {
  const beginModelCall = vi.fn(async (): Promise<number | null> => (overrides.seq === undefined ? 7 : overrides.seq));
  const recordModelCallStart = vi.fn(async (_seq: number, _upstream: string, _messageId: string): Promise<void> => undefined);
  const endModelCall = vi.fn(async (_seq: number, _end: MessagesCallEnd): Promise<void> => undefined);
  const fetch = vi.fn(upstream);
  vi.stubGlobal("fetch", fetch);
  return {
    beginModelCall,
    recordModelCallStart,
    endModelCall,
    fetch,
    deps: {
      plan: PLAN,
      keyOf: (name) => (name === "OPENROUTER_API_KEY" ? API_KEY : undefined),
      maxTokens: MAX_TOKENS,
      callTimeoutMs: overrides.callTimeoutMs ?? 60_000,
      registry: { beginModelCall, recordModelCallStart, endModelCall },
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

describe("relayModelCall: what reaches the plan's upstream", () => {
  it("sends the call to the plan's upstream with the key keyOf reads for it and the harness's anthropic-version", async () => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    await drain(await relayModelCall(harnessRequest(BODY, { headers: { authorization: "Bearer sk-placeholder" } }), h.deps));

    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/messages");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("clamps max_tokens to the job's limit and sends the plan's model", async () => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    await drain(await relayModelCall(harnessRequest({ ...BODY, max_tokens: 1_000_000 }), h.deps));

    expect(sentBody(h)).toMatchObject({ model: MODEL, max_tokens: MAX_TOKENS, stream: true });
  });
});

describe("relayModelCall: what reaches the harness", () => {
  it("answers with the upstream's status and event-stream type, its null counters deleted", async () => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    const res = await relayModelCall(harnessRequest(BODY), h.deps);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = dataEvents(await drain(res));
    expect(events.map((event) => event["type"])).toEqual(["message_start", "content_block_delta", "message_delta", "message_stop"]);
    expect(Object.values((events[0]!["message"] as { usage: Record<string, unknown> }).usage)).not.toContain(null);
  });
});

describe("relayModelCall: which requests it takes", () => {
  it.each([
    ["GET /v1/messages", "GET", "/v1/messages"],
    ["POST /v1/complete", "POST", "/v1/complete"],
    ["POST /v1/messages/count_tokens", "POST", "/v1/messages/count_tokens"],
    ["POST /", "POST", "/"],
  ])("refuses %s without beginning a call or reaching an upstream", async (_label, method, path) => {
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

  it("answers 409 without reaching an upstream when the job refuses to begin a call", async () => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]), { seq: null });
    const res = await relayModelCall(harnessRequest(BODY), h.deps);

    expect(res.status).toBe(409);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.endModelCall).not.toHaveBeenCalled();
  });
});

describe("relayModelCall: recording the call", () => {
  it("records who served the call and its message id, and ends it completed with its counters and cost", async () => {
    const h = harness(async () => upstreamStream([COMPLETE_STREAM]));
    await drain(await relayModelCall(harnessRequest(BODY), h.deps));

    await vi.waitFor(() => expect(h.endModelCall).toHaveBeenCalledTimes(1));
    expect(h.recordModelCallStart).toHaveBeenCalledWith(7, "openrouter", "gen-1762500000-abc");
    expect(h.endModelCall).toHaveBeenCalledWith(7, {
      outcome: "completed",
      upstream: "openrouter",
      tokens: { input: 41, output: 6, reasoning: 3, cacheRead: 128 },
      cost: { state: "known", usd: 0.000005838, source: "reported", tokens: { input: 169, cachedInput: 128, output: 6, reasoning: 3 } },
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
    expect(h.endModelCall).toHaveBeenCalledWith(7, { outcome: "upstream_error", upstream: null, tokens: null, cost: null });
    expect(h.recordModelCallStart).not.toHaveBeenCalled();
  });

  it("answers 502 and ends the call upstream_error when the upstream cannot be reached", async () => {
    const h = harness(async () => {
      throw new TypeError("fetch failed");
    });
    const res = await relayModelCall(harnessRequest(BODY), h.deps);

    expect(res.status).toBe(502);
    await vi.waitFor(() => expect(h.endModelCall).toHaveBeenCalledTimes(1));
    expect(h.endModelCall).toHaveBeenCalledWith(7, { outcome: "upstream_error", upstream: null, tokens: null, cost: null });
  });

  it("ends the call interrupted when the stream breaks after message_start", async () => {
    const h = harness(async () => upstreamStream([sse(MESSAGE_START), sse(CONTENT_DELTA)], "error"));
    await drain(await relayModelCall(harnessRequest(BODY), h.deps));

    await vi.waitFor(() => expect(h.endModelCall).toHaveBeenCalledTimes(1));
    expect(h.recordModelCallStart).toHaveBeenCalledWith(7, "openrouter", "gen-1762500000-abc");
    expect(h.endModelCall.mock.calls[0]![1]).toMatchObject({
      outcome: "interrupted",
      upstream: "openrouter",
      cost: { state: "pending", lookup: { upstream: "openrouter", generationId: "gen-1762500000-abc" } },
    });
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
      expect(h.endModelCall).toHaveBeenCalledWith(7, { outcome: "upstream_error", upstream: null, tokens: null, cost: null });
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
    expect(h.endModelCall).toHaveBeenCalledWith(7, { outcome: "upstream_error", upstream: null, tokens: null, cost: null });
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
