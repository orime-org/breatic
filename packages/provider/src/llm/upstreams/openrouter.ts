// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * OpenRouter, the gateway that serves every model the catch-all route reaches. Unlike a direct upstream it reports
 * each answer's cost, keeps a generation to look a cost up by later, ranks its own endpoints by price, lists its
 * models and serves the decisions endpoint.
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { numberLeaf, type Cost, type TokenBuckets } from "@provider/cost.js";
import { aiSdkFetch, fetchJson, sideBounds, SIDE_REQUEST_MS } from "@provider/http/request.js";
import { entryAt } from "@provider/llm/prices.js";
import { costedOf } from "@provider/llm/understand/openrouter.js";
import { asWritten, cacheControl, isClaude, type ReportedCosts, type Vendor, type VendorOptions } from "@provider/llm/upstreams/common.js";
import { openRouterRefusal } from "@provider/llm/upstreams/openrouter.messages.js";

/** The decisions endpoint's model (JEV), pinned to one version. */
const JEV_MODEL = "typesafe/jev-1.13";
/** The decisions endpoint, beside the API base. */
const JEV_PATH = "../alpha/decisions";

/** The largest generation answer read. */
const MAX_LOOKUP_BYTES = 1024 * 1024;

/** Provider metadata as far as the reported cost is read; a level it cannot read reads as absent. */
const reportedSchema = z.looseObject({
  openrouter: z.looseObject({ usage: z.looseObject({ cost: numberLeaf }).optional().catch(undefined) }).optional().catch(undefined),
});

/** The generation answer, as far as it is read. */
const generationSchema = z.looseObject({
  data: z.looseObject({
    total_cost: numberLeaf,
    native_tokens_prompt: numberLeaf,
    native_tokens_cached: numberLeaf,
    native_tokens_completion: numberLeaf,
    native_tokens_reasoning: numberLeaf,
  }),
});

/** The model list, as far as it is read. */
const modelListSchema = z.looseObject({ data: z.array(z.unknown()) });

/** One row of the model list; a row that is not shaped so is skipped. */
const modelRowSchema = z.looseObject({
  id: z.string(),
  architecture: z.looseObject({ input_modalities: z.array(z.unknown()).optional() }).nullish(),
});

/** One model's endpoint list, as far as it is read. */
const endpointListSchema = z.looseObject({ data: z.looseObject({ endpoints: z.array(z.unknown()) }) });

/**
 * The quantizations a cheapest call of one model takes: `openrouter_quantizations`, without `unknown` when one of
 * the model's endpoints states a level, since an endpoint that states none could then be a coarser host's.
 * @param quantizations - `openrouter_quantizations`.
 * @param statesQuantization - Whether one of the model's endpoints states a level (it is in `openrouter_states_quantization`).
 * @returns The levels the model's call takes.
 */
export function openRouterLevels<T extends string>(quantizations: T[], statesQuantization: boolean): T[] {
  return statesQuantization ? quantizations.filter((q) => q !== "unknown") : quantizations;
}

const costs: ReportedCosts = {
  reported(metadata) {
    const parsed = reportedSchema.safeParse(metadata);
    return parsed.success ? parsed.data.openrouter?.usage?.cost : undefined;
  },
  ofBody(body) {
    const costed = costedOf(body);
    return { id: costed.id, ...(costed.usage?.cost === undefined ? {} : { cost: costed.usage.cost }) };
  },
  isGeneration: (id): id is string => typeof id === "string" && id.startsWith("gen-"),
  async lookup(decl, key, generationId, lookup, lastAttempt) {
    /**
     * The answer when the upstream did not say: pending, or missing on the last attempt.
     * @param reason - Why.
     * @returns The cost.
     */
    const unanswered = (reason: string): Cost => (lastAttempt ? { state: "missing", reason } : { state: "pending", lookup });
    try {
      const body = await fetchJson(
        { url: `${decl.base_url}/generation?id=${encodeURIComponent(generationId)}`, method: "GET", headers: { authorization: `Bearer ${key}` } },
        { replaySafe: true, maxBodyBytes: MAX_LOOKUP_BYTES, idleMs: SIDE_REQUEST_MS, ...sideBounds() },
      );
      const parsed = generationSchema.safeParse(body);
      if (!parsed.success) return unanswered("the generation answer is not shaped as a generation");
      const data = parsed.data.data;
      const tokens: TokenBuckets = {
        input: data.native_tokens_prompt ?? 0,
        cachedInput: data.native_tokens_cached ?? 0,
        output: data.native_tokens_completion ?? 0,
        reasoning: data.native_tokens_reasoning ?? 0,
      };
      const cost = data.total_cost;
      if (cost === undefined) {
        const reason = "the generation carries no cost yet";
        return lastAttempt ? { state: "missing", reason, tokens } : { state: "pending", lookup };
      }
      return { state: "known", usd: cost, tokens, source: "billing" };
    } catch (error) {
      // fetchJson throws only Error instances.
      return unanswered((error as Error).message);
    }
  },
};

export const openrouter: Vendor = {
  sdkName: "openrouter",
  inBandStatus: (error) => {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "number" && Number.isInteger(code) ? code : undefined;
  },
  build: (decl, apiKey) => createOpenRouter({ baseURL: decl.base_url, apiKey, fetch: aiSdkFetch }),
  vendorId: asWritten,
  gateway: true,
  // OpenRouter lists max for DeepSeek and turns `xhigh` into `high`; `none` turns reasoning off.
  reasoning: {
    on: (modelId) => ({ reasoning: { effort: modelId.startsWith("deepseek/") ? "max" : "high" } }),
    off: { reasoning: { effort: "none" } },
    at: (level) => ({ reasoning: { effort: level } }),
  },
  // It turns a request-level mark into Anthropic's automatic caching; other models cache a prefix on their own.
  cache: (modelId, ttl) => (isClaude(modelId) ? cacheControl(ttl) : {}),
  refusal: openRouterRefusal,
  costs,
  listedPrice(llm, modelId, at) {
    // While a dated direct price is in effect, prices read before it took effect (or read at a moment the file does
    // not state) are another moment's prices: unknown, so this upstream ranks last. Under a model's first price, or
    // with no direct price, they are ranked.
    const entries = llm.prices[modelId];
    const changedAt = entries === undefined ? undefined : entryAt(entries, at).from;
    const readAt = llm.openrouter_prices_at === undefined ? -Infinity : Date.parse(llm.openrouter_prices_at);
    return changedAt !== undefined && Date.parse(changedAt) > readAt ? undefined : llm.openrouter_prices[modelId];
  },
  routing(llm, modelId, cheapest, pinned) {
    // In cheapest mode its endpoints cheapest first within the model's quantizations (a cheapest call is ranked by
    // that endpoint, `openrouter_prices`); for an understand call the model's backend pin, which is understand's alone.
    const routing: VendorOptions = {
      ...(pinned ? llm.openrouter_backends[modelId] : {}),
      ...(cheapest ? { sort: "price", quantizations: openRouterLevels(llm.openrouter_quantizations, llm.openrouter_states_quantization.includes(modelId)) } : {}),
    };
    return Object.keys(routing).length === 0 ? undefined : routing;
  },
  catalog: {
    url: (decl) => `${decl.base_url}/models`,
    read(body) {
      const list = modelListSchema.safeParse(body);
      if (!list.success) return undefined;
      const pictures = new Map<string, boolean>();
      for (const raw of list.data.data) {
        // A row it cannot read is skipped; the rest of the list still counts.
        const row = modelRowSchema.safeParse(raw);
        if (!row.success) continue;
        pictures.set(row.data.id, row.data.architecture?.input_modalities?.includes("image") === true);
      }
      return pictures;
    },
    // It keeps a conversation on one endpoint (a call's `session`), so the window a turn can count on is the smallest
    // `context_length` among the model's endpoints, not the model-level figure (inner#1567).
    contextWindow: {
      url: (decl, modelId) => `${decl.base_url}/models/${modelId}/endpoints`,
      read(body) {
        const list = endpointListSchema.safeParse(body);
        if (!list.success) return undefined;
        const lengths = list.data.data.endpoints.flatMap((endpoint) => {
          const value = (endpoint as { context_length?: unknown } | null)?.context_length;
          return typeof value === "number" && Number.isFinite(value) && value > 0 ? [value] : [];
        });
        return lengths.length === 0 ? undefined : Math.min(...lengths);
      },
    },
  },
  decisions: { model: JEV_MODEL, url: (decl) => new URL(JEV_PATH, `${decl.base_url}/`).toString() },
};
