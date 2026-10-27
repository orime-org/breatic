// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { FinishReason, JSONValue, LanguageModel, LanguageModelUsage, ProviderMetadata, SystemModelMessage } from "ai";
import type { Cost } from "@provider/cost.js";
import type { Route } from "@provider/routing/route.js";

/** What a caller asks of one LLM call (design 3.5). */
export interface CallWants {
  thinking: boolean;
  /** The prompt cache lifetime asked for, or false for none. */
  cache: false | "5m" | "1h";
  /** The conversation the call belongs to, so a gateway keeps it on one backend. */
  session?: string;
  temperature?: number;
}

/** The system prompt in the parts other conversations share. */
export interface SystemParts {
  base: string;
  project?: string;
  conversation?: string;
}

/** One prepared call: hand `model` and `options` to `generateText` or `streamText`. */
export interface PreparedCall {
  /** Tries the route's upstreams in order until the first content, then stays on the one that served it. */
  model: LanguageModel;
  options: { providerOptions: Record<string, Record<string, JSONValue>>; maxRetries: 0; temperature?: number };
  /** The system messages, with each upstream's cache marks. */
  system(parts: SystemParts): SystemModelMessage[];
  /** The lookup of every model call this call opened that has not finished. */
  pendingCosts(): Cost[];
}

/** What a finished model call reports, as the AI SDK hands it over. */
export interface FinishedCall {
  model: string;
  usage: LanguageModelUsage;
  providerMetadata?: ProviderMetadata;
}

/** One reading of media by an understand model (design 6.5). */
export interface UnderstandRequest {
  model: string;
  question: string;
  media: { bytes: Uint8Array; contentType: string }[];
  maxOutputTokens: number;
  deadlineAt: number;
  signal?: AbortSignal;
}

/** What the understand model answered. */
export interface UnderstandAnswer {
  text: string;
  /** Why the model stopped, in the AI SDK's unified words, the same for every upstream. */
  finishReason: FinishReason;
  cost: Cost;
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
  cost: Cost;
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
  understand(request: UnderstandRequest, route?: Route): Promise<UnderstandAnswer>;
  judge(request: JudgeRequest, route?: Route): Promise<JudgeAnswer>;
  capabilities(modelId: string, policy: CapabilityPolicy, signal?: AbortSignal): Promise<{ pictures: boolean }>;
  /**
   * Check that every model this deployment reaches directly (not through a
   * gateway that reports its own cost) has token prices in llm.yaml.
   * @throws {ProviderConfigError} One problem per model and upstream without a price.
   */
  assertModelsPriced(models: readonly string[]): void;
}
