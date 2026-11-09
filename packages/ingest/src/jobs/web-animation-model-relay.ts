// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `model.local` outbound relay of the web-animation container (inner#1711 design §6, DD §3.1).
 *
 * Every process in the container can reach `model.local`, so this relay, not the harness, decides what reaches
 * OpenRouter: only `POST /v1/messages`, a body rebuilt from the Messages field allowlist (`dsh_session_log` and every
 * extension dropped), a forced stream, `max_tokens` clamped to the job's limit, the job's model, `anthropic-version`
 * and our key as the only headers, and DeepSeek's `thinking {type: "enabled"}` without a budget rewritten to
 * OpenRouter's `adaptive`. The answer streams back with every null usage counter deleted, because the harness rejects
 * null where it accepts a missing counter.
 *
 * Each call is registered with the job's Durable Object before it is sent and ended exactly once, whatever happens
 * to it; the object refuses a new call while one is open or once the job is stopping. A plain function so it runs on
 * Node in tests; the container class wires it to its outbound handler.
 */

import type { WebAnimationJobCall } from "@breatic/shared/space-content";

/** The fake host the container's harness sends model calls to. */
export const MODEL_HOST = "model.local";

/** OpenRouter's Anthropic-compatible Messages endpoint. */
export const OPENROUTER_MESSAGES_URL = "https://openrouter.ai/api/v1/messages";

/** The Messages fields a call may carry upstream; everything else the harness sends is dropped. */
const ALLOWED_FIELDS = [
  "model", "messages", "system", "tools", "tool_choice", "max_tokens", "stream", "thinking", "output_config",
  "temperature", "top_p", "stop_sequences", "metadata",
] as const;

/** How a call ended, as the job object records it. */
export type ModelCallEnd = Pick<WebAnimationJobCall, "tokens" | "costUsd"> & {
  outcome: Exclude<WebAnimationJobCall["outcome"], "cut_off">;
};

/** What the relay needs: the job's limits, our key, the job object's registry and a way to reach OpenRouter. */
export interface ModelRelayDeps {
  apiKey: string;
  model: string;
  maxTokens: number;
  callTimeoutMs: number;
  registry: {
    /** A seq for the new call, or null when the job refuses one. */
    beginModelCall: () => Promise<number | null>;
    recordModelCallStart: (seq: number, generationId: string) => Promise<void>;
    endModelCall: (seq: number, end: ModelCallEnd) => Promise<void>;
  };
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

const FAILED: ModelCallEnd = { outcome: "upstream_error", tokens: null, costUsd: null };

/**
 * Whether a value is a JSON object.
 * @param value - The value.
 * @returns True for a non-null, non-array object.
 * @throws {never} Never.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The body sent upstream, rebuilt from what the harness sent.
 * @param asked - The harness's body.
 * @param deps - The job's model and token limit.
 * @returns The body.
 * @throws {never} Never.
 */
function upstreamBody(asked: Record<string, unknown>, deps: ModelRelayDeps): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of ALLOWED_FIELDS) if (Object.hasOwn(asked, field)) body[field] = asked[field];
  body["model"] = deps.model;
  body["stream"] = true;
  const askedMax = asked["max_tokens"];
  body["max_tokens"] = typeof askedMax === "number" && askedMax < deps.maxTokens ? askedMax : deps.maxTokens;
  const thinking = asked["thinking"];
  if (isObject(thinking) && thinking["type"] === "enabled" && thinking["budget_tokens"] === undefined) {
    body["thinking"] = { type: "adaptive" };
  }
  return body;
}

/**
 * Delete the null counters of a usage object in place.
 * @param usage - The usage object, if any.
 * @throws {never} Never.
 */
function dropNullCounters(usage: unknown): void {
  if (!isObject(usage)) return;
  for (const key of Object.keys(usage)) if (usage[key] === null) delete usage[key];
}

/**
 * A non-negative integer counter, or zero.
 * @param value - The counter.
 * @returns It, or zero when missing or invalid.
 * @throws {never} Never.
 */
function counter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Relay one model call from the container to OpenRouter.
 * @param request - What the harness sent to `model.local`.
 * @param deps - The job's limits, our key, the registry and fetch.
 * @returns The upstream answer, streamed; 403 for anything but `POST /v1/messages`, 400 for a body that is not a JSON
 *   object, 409 when the job refuses a call, 502 when OpenRouter could not be reached.
 * @throws {unknown} What the registry throws when the job object cannot be reached.
 */
export async function relayModelCall(request: Request, deps: ModelRelayDeps): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/messages") {
    return new Response("Not allowed", { status: 403 });
  }
  let asked: unknown;
  try {
    asked = JSON.parse(await request.text());
  } catch {
    return new Response("Not a Messages body", { status: 400 });
  }
  if (!isObject(asked)) return new Response("Not a Messages body", { status: 400 });

  const seq = await deps.registry.beginModelCall();
  if (seq === null) return new Response("The job takes no model call now", { status: 409 });

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deps.callTimeoutMs);
  const abandon = (): void => abort.abort();
  request.signal.addEventListener("abort", abandon);
  let ended = false;
  /**
   * End the call; only the first end counts.
   * @param end - How it ended.
   * @returns Nothing.
   * @throws {unknown} What the registry throws.
   */
  const finish = async (end: ModelCallEnd): Promise<void> => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abandon);
    await deps.registry.endModelCall(seq, end);
  };

  const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${deps.apiKey}` });
  const version = request.headers.get("anthropic-version");
  if (version !== null) headers.set("anthropic-version", version);
  let upstream: Response;
  try {
    upstream = await deps.fetch(OPENROUTER_MESSAGES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody(asked, deps)),
      signal: abort.signal,
    });
  } catch {
    await finish(FAILED);
    return new Response("The model service could not be reached", { status: 502 });
  }
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  if (!upstream.ok || upstream.body === null) {
    await finish(FAILED);
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": contentType } });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let started = false;
  let completed: ModelCallEnd | null = null;
  /**
   * How the call ended when its stream stops.
   * @returns The end.
   * @throws {never} Never.
   */
  const stoppedEnd = (): ModelCallEnd => completed ?? (started ? { outcome: "interrupted", tokens: null, costUsd: null } : FAILED);
  /**
   * Rewrite one line, noting what it says about the call.
   * @param line - One line of the stream, without its newline.
   * @returns The line to pass on.
   * @throws {unknown} What the registry throws.
   */
  const rewrite = async (line: string): Promise<string> => {
    const carriage = line.endsWith("\r") ? "\r" : "";
    const content = carriage === "" ? line : line.slice(0, -1);
    if (!content.startsWith("data:")) return line;
    let event: unknown;
    try {
      event = JSON.parse(content.slice(5));
    } catch {
      return line;
    }
    if (!isObject(event)) return line;
    const message = event["message"];
    if (isObject(message)) dropNullCounters(message["usage"]);
    dropNullCounters(event["usage"]);
    if (event["type"] === "message_start" && !started) {
      started = true;
      if (isObject(message) && typeof message["id"] === "string") await deps.registry.recordModelCallStart(seq, message["id"]);
    }
    const usage = event["usage"];
    if (event["type"] === "message_delta" && isObject(usage)) {
      const details = usage["output_tokens_details"];
      completed = {
        outcome: "completed",
        tokens: {
          input: counter(usage["input_tokens"]),
          output: counter(usage["output_tokens"]),
          reasoning: counter(isObject(details) ? details["thinking_tokens"] : undefined),
          cacheRead: counter(usage["cache_read_input_tokens"]),
        },
        costUsd: typeof usage["cost"] === "number" && usage["cost"] >= 0 ? usage["cost"] : null,
      };
    }
    return `data: ${JSON.stringify(event)}${carriage}`;
  };

  const relayed = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          await finish(stoppedEnd());
          controller.error(err);
          return;
        }
        if (chunk.done) {
          pending += decoder.decode();
          if (pending !== "") controller.enqueue(encoder.encode(await rewrite(pending)));
          pending = "";
          await finish(stoppedEnd());
          controller.close();
          return;
        }
        pending += decoder.decode(chunk.value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        if (lines.length === 0) continue;
        const out: string[] = [];
        for (const line of lines) out.push(await rewrite(line));
        controller.enqueue(encoder.encode(`${out.join("\n")}\n`));
        return;
      }
    },
    async cancel(reason): Promise<void> {
      abort.abort();
      await reader.cancel(reason).catch(() => undefined);
      await finish(stoppedEnd());
    },
  }, { highWaterMark: 0 });
  return new Response(relayed, { status: upstream.status, headers: { "content-type": contentType } });
}
