// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { FinishReason, JSONValue, LanguageModelUsage, ProviderMetadata, SystemModelMessage } from "ai";
import type { Cost, PendingCost } from "@provider/cost.js";
import type { ModelV4 } from "@provider/llm/upstreams/common.js";
import type { MessagesPlan } from "@provider/messages/relay.js";
import type { Availability } from "@provider/pricing/estimate.js";
import type { Route } from "@provider/routing/route.js";

/** What a caller asks of one LLM call. */
export interface CallWants {
  thinking: boolean;
  /** The prompt cache lifetime asked for, or false for none. */
  cache: false | "5m" | "1h";
  /** The conversation the call belongs to, so a gateway keeps it on one backend. */
  session?: string;
  temperature?: number;
  /**
   * How long the model thinks, on the upstreams that take a named level (OpenRouter `reasoning.effort`, Google
   * `thinkingLevel`); read only with `thinking` on. Without it each upstream asks for its own depth.
   */
  thinkingLevel?: "low" | "medium" | "high";
}

/** The system prompt in the parts other conversations share. */
export interface SystemParts {
  base: string;
  project?: string;
  conversation?: string;
  /** The Project Instructions, sent last and never marked: the Project's members change them at any moment. */
  projectInstructions?: string;
}

/** One prepared call: hand `model` and `options` to `generateText` or `streamText`. */
export interface PreparedCall {
  /** Tries the route's upstreams in order until the first content, then stays on the one that served it. */
  model: ModelV4;
  options: { providerOptions: Record<string, Record<string, JSONValue>>; maxRetries: 0; temperature?: number };
  /** The system messages, with each upstream's cache marks. */
  system(parts: SystemParts): SystemModelMessage[];
  /**
   * Each billed answer the call could not hand over in a finish: a lookup when its generation
   * id is known, else a missing cost.
   */
  pendingCosts(): PendingCost[];
}

/**
 * What a finished model call reports, as the AI SDK hands it over. Its `providerMetadata.breatic`
 * is provider's own: who served the call and when the request that served it was sent (`sentAt`,
 * which picks a direct price), so the caller measures nothing itself.
 */
export interface FinishedCall {
  model: string;
  usage: LanguageModelUsage;
  providerMetadata?: ProviderMetadata;
}

/**
 * One item to read: its bytes, or an image by its address with the type the caller settled and a reader for the bytes.
 * An upstream that fetches an address itself is sent the address; one that needs the bytes calls `read`, whose error
 * ends the call as `UnderstandInterrupted` with that error as its cause.
 */
export type UnderstandMedia =
  | { bytes: Uint8Array; contentType: string }
  | { url: string; contentType: string; read: (signal: AbortSignal) => Promise<Uint8Array> };

/** One reading of media by an understand model. */
export interface UnderstandRequest {
  model: string;
  question: string;
  media: UnderstandMedia[];
  maxOutputTokens: number;
  deadlineAt: number;
  signal?: AbortSignal;
}

/** What the understand model answered. */
export interface UnderstandAnswer {
  text: string;
  /** Why the model stopped, in the AI SDK's unified words, the same for every upstream. */
  finishReason: FinishReason;
  /** Every billed answer, in order: those moved past by a retry or switch, then the one answered. */
  costs: Cost[];
  upstream: string;
}

/** One question to the decisions endpoint (JEV). */
export interface JudgeRequest {
  state: unknown;
  questions: Record<string, Record<string, unknown>>;
  /** How long the whole call may take. */
  budgetMs: number;
  signal?: AbortSignal;
}

/** What the decisions endpoint answered: any status comes back for the caller to read. */
export interface JudgeAnswer {
  status: number;
  body: string;
  /** What a 2xx answer cost; absent on a refusal, which was not billed. */
  cost?: Cost;
  /** The upstream that answered, and the decisions model it was asked of. */
  upstream: string;
  model: string;
}

/** How a model's picture capability is decided. */
export interface CapabilityPolicy {
  override: "auto" | "yes" | "no";
  timeoutMs: number;
  ttlMs: number;
  retryMs: number;
}

/** The LLM part of a provider instance. */
export interface LlmApi {
  prepare(modelId: string, wants: CallWants, route?: Route): PreparedCall;
  costOf(finished: FinishedCall): Cost;
  /** The upstream a finished call names as the one that served it, when the configuration declares it. */
  servedBy(finished: Pick<FinishedCall, "providerMetadata">): string | undefined;
  understand(request: UnderstandRequest, route?: Route): Promise<UnderstandAnswer>;
  judge(request: JudgeRequest, route?: Route): Promise<JudgeAnswer>;
  /**
   * Where a web-animation Messages call of a model may go, in order, for the Worker that relays it: every upstream of
   * the model's route that takes a Messages request, with no key read here.
   * @throws {UpstreamRequestRejected} When the route pins an upstream that takes none for this model.
   * @throws {NoUpstreamAvailable} When no upstream of the route takes one.
   */
  messagesPlan(modelId: string, route?: Route): MessagesPlan;
  capabilities(modelId: string, policy: CapabilityPolicy, signal?: AbortSignal): Promise<{ pictures: boolean; contextWindow?: number }>;
  /**
   * Check that every model this deployment reaches directly (not through a
   * gateway that reports its own cost) has token prices in llm.yaml.
   * @throws {ProviderConfigError} One problem per model and upstream without a price.
   */
  assertModelsPriced(models: readonly string[]): void;
  /**
   * The upstreams a model's calls of one use would try, in effective weight order, each
   * saying whether its key is configured: `call` by the routes `prepare` uses,
   * `understand` by the understanding routes.
   */
  availability(modelId: string, use: "call" | "understand"): Availability;
  /**
   * The upstreams that serve the decisions endpoint, each saying whether its key is configured, the one `judge` sends
   * to first (it tries no other; the weights are list positions).
   */
  judgeAvailability(): Availability;
}
