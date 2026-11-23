// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The model calls of the web-animation container, relayed from the ingest Worker (`@breatic/provider/messages`). The
 * Worker has no provider configuration and no key of its own: the application plans the call on Node
 * (`provider.llm.messagesPlan`) and hands the plan over with the job, the Worker reads each call's keys by upstream
 * (inner#1953), and this relay sends each call to the plan's upstreams in order, moving on before the first answer by
 * the same rules as every other call, and tells the caller who served it and what it cost. It runs in a Cloudflare
 * Worker, so it imports nothing that needs Node beyond `AsyncLocalStorage`.
 */

import { paidBy, type Cost } from "@provider/cost.js";
import { NotSent } from "@provider/http/errors.js";
import { answerText, isSuccess, parsed, send } from "@provider/http/request.js";
import type { PriceEntries } from "@provider/llm/prices.js";
import { counter, type MessagesSpeaker } from "@provider/llm/upstreams/common.js";
import { messagesSpeakerOf } from "@provider/llm/upstreams/messages.js";
import { accountFailureOf, decide, type AccountKeyFailureKind, type AccountKeyFailureReason, type Failure } from "@provider/routing/decide.js";

/** The Messages fields a call may carry upstream; everything else the caller sends is dropped. */
const ALLOWED_FIELDS = [
  "model", "messages", "system", "tools", "tool_choice", "max_tokens", "stream", "thinking", "output_config",
  "temperature", "top_p", "stop_sequences", "metadata",
] as const;

/** The largest refusal body read. */
const MAX_REFUSAL_BYTES = 1024 * 1024;
/** How long a refusal body may stall. */
const REFUSAL_IDLE_MS = 30_000;

/** One upstream of a plan, as the application planned it on Node: everything the Worker needs but the key. */
export interface MessagesCandidate {
  upstream: string;
  kind: string;
  baseUrl: string;
  /** The id this upstream serves the model under. */
  vendorModel: string;
  /** The environment variable of its key on our services, named for whoever sets it up; the relay asks for keys by upstream. */
  keyEnv: string;
  /** The model's direct prices, for an upstream priced from `llm.yaml`. */
  prices?: PriceEntries;
}

/** Where one model's Messages calls go, in order; serializable, carried with the job. */
export interface MessagesPlan {
  model: string;
  /** `account` when the plan was made on an account's keys (inner#1953); absent for the deployment's. */
  keysOwner?: "account";
  candidates: MessagesCandidate[];
}

/** A failure of the payer's own key or its upstream, read by the upstream's own reader (inner#1953); `lasting` says whether asking again can change it. */
export interface AccountKeyRefusal {
  upstream: string;
  kind: AccountKeyFailureKind;
  reason?: AccountKeyFailureReason;
  /** True when asking again cannot change it; a 429, a 5xx or an upstream never reached is false. */
  lasting: boolean;
}

/** The counters of a completed call, as its usage stated them. */
export interface MessagesTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
}

/** How one relayed call ended: who served it, its counters and what it cost. An upstream error cost nothing. */
export interface MessagesCallEnd {
  outcome: "completed" | "upstream_error" | "interrupted";
  upstream: string | null;
  tokens: MessagesTokens | null;
  cost: Cost | null;
}

/** What the relay needs from its caller. */
export interface RelayOptions {
  /** Reads the key the caller holds for one upstream of the plan, as a `KeySet` does; undefined or empty means none. */
  keyOf: (upstream: string) => string | undefined;
  /** The highest max_tokens a call may ask for. */
  maxTokens: number;
  /** Stops the call, whatever it is doing. */
  signal: AbortSignal;
  /** The header the caller's request carried, forwarded as it came. */
  anthropicVersion?: string;
  /** Awaited once message_start names the message, with the upstream that serves the call. */
  onStarted: (upstream: string, messageId: string) => Promise<void>;
  /** Awaited exactly once per call, before the answer's stream closes or errors. */
  onEnded: (end: MessagesCallEnd) => Promise<void>;
  /**
   * Awaited before the call ends when a plan on the payer's own keys failed on its key or upstream, with the last such
   * failure: one that lasts (the key invalid, out of balance or not reaching the model) or a passing one the caller may
   * ask again after (a 429, a 5xx, the upstream never reached). The deployment's keys are never used.
   */
  onAccountKeyRefused?: (refusal: AccountKeyRefusal) => Promise<void>;
}

const FAILED: MessagesCallEnd = { outcome: "upstream_error", upstream: null, tokens: null, cost: null };

/**
 * Whether a value is a JSON object.
 * @param value - The value.
 * @returns True for a non-null, non-array object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The body sent upstream, rebuilt from what the caller sent: the allowlisted fields, the candidate's model, a forced
 * stream and max_tokens no higher than the limit.
 * @param asked - The caller's body.
 * @param vendorModel - The candidate's model id.
 * @param maxTokens - The limit.
 * @returns The body.
 */
function upstreamBody(asked: Record<string, unknown>, vendorModel: string, maxTokens: number): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of ALLOWED_FIELDS) if (Object.hasOwn(asked, field)) body[field] = asked[field];
  body["model"] = vendorModel;
  body["stream"] = true;
  const askedMax = asked["max_tokens"];
  body["max_tokens"] = typeof askedMax === "number" && askedMax < maxTokens ? askedMax : maxTokens;
  return body;
}

/**
 * Delete the null counters of a usage object in place; a client that takes a missing counter rejects a null one.
 * @param usage - The usage object, if any.
 */
function dropNullCounters(usage: unknown): void {
  if (!isObject(usage)) return;
  for (const key of Object.keys(usage)) if (usage[key] === null) delete usage[key];
}

/**
 * Relay one Messages call along the plan.
 * @param plan - The plan.
 * @param asked - The caller's body, a JSON object.
 * @param options - Keys, limits, signal and the two callbacks.
 * @returns The answer, streamed when an upstream served the call; a refusal passed through as it came; 502 when no
 *   upstream could be reached.
 */
export async function relayMessages(plan: MessagesPlan, asked: Record<string, unknown>, options: RelayOptions): Promise<Response> {
  let refused: { status: number; text: string; contentType: string } | undefined;
  let keyRefused: AccountKeyRefusal | undefined;
  for (const candidate of plan.candidates) {
    const speaker = messagesSpeakerOf(candidate.kind);
    const key = options.keyOf(candidate.upstream);
    if (speaker === undefined || key === undefined || key === "") continue;
    const body = upstreamBody(asked, candidate.vendorModel, options.maxTokens);
    speaker.rewrite?.(body);
    const url = speaker.url(candidate.baseUrl);
    const headers = {
      "content-type": "application/json",
      ...speaker.auth(key),
      ...(options.anthropicVersion === undefined ? {} : { "anthropic-version": options.anthropicVersion }),
    };
    const sentAt = Date.now();
    const bounds = { replaySafe: false, signal: options.signal };
    let response: Response;
    try {
      response = await send({ url, method: "POST", headers, body: JSON.stringify(body) }, bounds);
    } catch (error) {
      // A request that never left moves on; one that left without an answer, or was stopped, ends the call there.
      if (error instanceof NotSent) {
        if (plan.keysOwner === "account") keyRefused = { upstream: candidate.upstream, kind: "upstream_unavailable", lasting: false };
        continue;
      }
      break;
    }
    const contentType = response.headers.get("content-type") ?? "application/json";
    if (isSuccess(response.status) && response.body !== null) return relayed(candidate, speaker, response, sentAt, contentType, options, plan.keysOwner);
    const text = await answerText(url, response, MAX_REFUSAL_BYTES, REFUSAL_IDLE_MS, bounds).catch(() => "");
    const refusal = speaker.refusal(response.status, parsed(text));
    refused = { status: response.status, text, contentType };
    const failure: Failure = refusal === undefined ? { kind: "http_status", status: response.status } : { kind: refusal };
    const turned = plan.keysOwner === "account" ? accountFailureOf(failure, "llm_before_content") : undefined;
    if (turned !== undefined) {
      keyRefused = { upstream: candidate.upstream, kind: turned.kind, ...(turned.reason === undefined ? {} : { reason: turned.reason }), lasting: turned.lasting };
      if (turned.lasting) break;
    }
    if (decide(failure, "llm_before_content", 0, 0) !== "switch") break;
  }
  if (keyRefused !== undefined) await options.onAccountKeyRefused?.(keyRefused);
  await options.onEnded(FAILED);
  return refused === undefined
    ? new Response("The model service could not be reached", { status: 502 })
    : new Response(refused.text, { status: refused.status, headers: { "content-type": refused.contentType } });
}

/**
 * The answer an upstream served, streamed on with its null counters removed, the call started once message_start
 * names it and ended once, before the stream closes or errors.
 * @param candidate - Who served it.
 * @param speaker - How its kind speaks Messages.
 * @param upstream - Its answer.
 * @param sentAt - When the request was sent.
 * @param contentType - The answer's type.
 * @param options - The caller's callbacks.
 * @param payer - `account` when the plan runs on the payer's keys.
 * @returns The answer to hand the caller.
 */
function relayed(candidate: MessagesCandidate, speaker: MessagesSpeaker, upstream: Response, sentAt: number, contentType: string, options: RelayOptions, payer: "account" | undefined): Response {
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let started = false;
  let messageId: string | undefined;
  // message_start states the input and cache counts, message_delta the final ones it repeats or adds (Anthropic sends
  // only the output there, OpenRouter every count); the call completed once message_delta arrived, usage or none.
  let startUsage: Record<string, unknown> = {};
  let usage: Record<string, unknown> | undefined;
  let ended = false;

  /**
   * End the call; only the first end counts. A call that never started cost nothing; one that started and did not
   * complete is interrupted.
   * @returns Nothing.
   */
  const end = async (): Promise<void> => {
    // message_stop ends the call; the EOF, read error or cancel that follows reaches here again and counts nothing.
    if (ended) return;
    ended = true;
    if (!started && usage === undefined) {
      await options.onEnded(FAILED);
      return;
    }
    // A call on the payer's keys is the payer's, and so is the lookup of a cost still pending.
    const cost = paidBy(payer)(speaker.cost({ upstream: candidate.upstream, messageId, usage, sentAt, prices: candidate.prices }));
    if (usage === undefined) {
      await options.onEnded({ outcome: "interrupted", upstream: candidate.upstream, tokens: null, cost });
      return;
    }
    const details = usage["output_tokens_details"];
    const tokens: MessagesTokens = {
      input: counter(usage["input_tokens"]),
      output: counter(usage["output_tokens"]),
      reasoning: counter(isObject(details) ? details["thinking_tokens"] : undefined),
      cacheRead: counter(usage["cache_read_input_tokens"]),
    };
    await options.onEnded({ outcome: "completed", upstream: candidate.upstream, tokens, cost });
  };

  /**
   * Rewrite one line, noting what it says about the call.
   * @param line - One line of the stream, without its newline.
   * @returns The line to pass on.
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
      if (isObject(message) && isObject(message["usage"])) startUsage = { ...message["usage"] };
      if (isObject(message) && typeof message["id"] === "string") {
        messageId = message["id"];
        await options.onStarted(candidate.upstream, messageId);
      }
    }
    if (event["type"] === "message_delta") usage = { ...startUsage, ...(isObject(event["usage"]) ? event["usage"] : {}) };
    // The harness takes message_stop as the end of the call and sends its next one at once, while the upstream may
    // still hold the body open; the call is ended before the harness can see it.
    if (event["type"] === "message_stop") await end();
    return `data: ${JSON.stringify(event)}${carriage}`;
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          await end();
          controller.error(error);
          return;
        }
        if (chunk.done) {
          pending += decoder.decode();
          if (pending !== "") controller.enqueue(encoder.encode(await rewrite(pending)));
          pending = "";
          await end();
          controller.close();
          return;
        }
        pending += decoder.decode(chunk.value, { stream: true });
        // Whole lines are passed on; the part after the last newline waits for the next chunk.
        const cut = pending.lastIndexOf("\n");
        if (cut < 0) continue;
        const lines = pending.slice(0, cut).split("\n");
        pending = pending.slice(cut + 1);
        const out: string[] = [];
        for (const line of lines) out.push(await rewrite(line));
        controller.enqueue(encoder.encode(`${out.join("\n")}\n`));
        return;
      }
    },
    async cancel(reason): Promise<void> {
      await reader.cancel(reason).catch(() => undefined);
      await end();
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: upstream.status, headers: { "content-type": contentType } });
}
