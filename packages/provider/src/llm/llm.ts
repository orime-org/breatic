// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The LLM part of a provider instance (design 3.5): routing a model id to
 * its upstreams, what each upstream is sent, the cost of a finished call,
 * reading media, the decisions endpoint and the picture capability.
 */

import { generateText, type JSONValue, type SystemModelMessage } from "ai";
import { hasKey, type LlmRoute, type ProviderConfig } from "@provider/config/schema.js";
import type { Cost } from "@provider/cost.js";
import { NoUpstreamAvailable, UpstreamRequestRejected } from "@provider/errors.js";
import { readBody, send } from "@provider/http/request.js";
import type { CapabilityPolicy, CallWants, FinishedCall, LlmApi, PreparedCall, SystemParts } from "@provider/llm/api.js";
import { classifyLlm, reportedCost, SwitchingModel } from "@provider/llm/switching.js";
import { cacheMark, isClaude, optionsFor, vendorOf, type ModelV4, type VendorOptions } from "@provider/llm/vendors.js";
import type { ProviderOptions } from "@provider/provider.js";
import { planRoute, type Candidate, type Route, type RoutePlan } from "@provider/routing/route.js";
import { tryInOrder } from "@provider/routing/try-in-order.js";

/** The decisions endpoint's model (JEV), pinned like domain's `JEV_PINS`. */
const JEV_MODEL = "typesafe/jev-1.13";
/** The decisions endpoint, beside the OpenRouter API base. */
const JEV_PATH = "../alpha/decisions";
const DEFAULT_ROUTE: Route = { mode: "default" };

/**
 * The deadline signal of a call, joined with the caller's.
 * @param deadlineAt - Epoch ms.
 * @param signal - The caller's signal.
 * @returns The signal.
 */
function untilDeadline(deadlineAt: number, signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(Math.max(0, Math.trunc(deadlineAt - Date.now())));
  return signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
}

/**
 * Apply the caller's text cleaning to every string and key of a value.
 * @param value - The value.
 * @param clean - The cleaning.
 * @returns The cleaned copy.
 */
function cleanDeep(value: unknown, clean: (text: string) => string): unknown {
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map((v) => cleanDeep(v, clean));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(k), cleanDeep(v, clean)]));
  }
  return value;
}

/**
 * The LLM part of a provider instance.
 * @param config - The validated configuration.
 * @param options - The caller's options.
 * @returns The LLM API.
 */
export function createLlm(config: ProviderConfig, options: ProviderOptions): LlmApi {
  const factories = new Map<string, (modelId: string) => ModelV4>();
  let catalog: { pictures: ReadonlyMap<string, boolean>; freshUntil: number; retryAfter: number; refreshing?: Promise<void> } = {
    pictures: new Map(),
    freshUntil: 0,
    retryAfter: 0,
  };

  /**
   * An upstream's adapter kind.
   * @param upstream - The upstream.
   * @returns Its kind.
   */
  const kindOf = (upstream: string): string => config.upstreams[upstream]!.kind;

  /**
   * The model an upstream serves our model id as.
   * @param route - The route that matched.
   * @param upstream - The upstream.
   * @param modelId - Our model id.
   * @returns Its model.
   */
  const modelOn = (route: LlmRoute, upstream: string, modelId: string): ModelV4 => {
    const decl = config.upstreams[upstream]!;
    const vendor = vendorOf(decl.kind);
    let factory = factories.get(upstream);
    if (factory === undefined) {
      factory = vendor.build(decl, options.keyOf(decl.key_env) ?? "");
      factories.set(upstream, factory);
    }
    const pinnedId = config.llm.vendor_ids[modelId]?.[upstream];
    const id = pinnedId ?? (vendor.gateway ? modelId : vendor.vendorId(modelId.slice(route.prefix.length)));
    return factory(id);
  };

  /**
   * The first route a model id matches.
   * @param routes - The routes to look in.
   * @param modelId - Our model id.
   * @returns The route.
   * @throws {UpstreamRequestRejected} When no route matches.
   */
  const routeOf = (routes: readonly LlmRoute[], modelId: string): LlmRoute => {
    const route = routes.find((r) => modelId.startsWith(r.prefix));
    if (route === undefined) throw new UpstreamRequestRejected(modelId, "", `No LLM route matches ${modelId}`);
    return route;
  };

  /**
   * The upstreams a call tries, in order.
   * @param route - The matched route.
   * @param modelId - Our model id.
   * @param chosen - The caller's mode.
   * @returns The plan.
   * @throws {NoUpstreamAvailable} When none is configured.
   * @throws {UpstreamRequestRejected} When the mode names an upstream the route does not have.
   */
  const planFor = (route: LlmRoute, modelId: string, chosen: Route): RoutePlan => {
    const candidates: Candidate[] = route.upstreams.map(({ upstream, weight }) => {
      const envVar = config.upstreams[upstream]!.key_env;
      return { upstream, weight, configured: hasKey(options.keyOf, envVar), envVar };
    });
    if (chosen.mode !== "cheapest") return planRoute(modelId, chosen, candidates);
    // Cheapest by unit price: input first, then output; an upstream without a price goes last.
    const plan = planRoute(modelId, DEFAULT_ROUTE, candidates);
    /**
     * An upstream's input and output unit prices.
     * @param c - The upstream.
     * @returns Both prices; infinite when unknown.
     */
    const price = (c: Candidate): [number, number] => {
      const p = kindOf(c.upstream) === "openrouter" ? undefined : config.llm.prices[modelId];
      return p === undefined ? [Infinity, Infinity] : [p.input_cache_miss_per_mtok, p.output_per_mtok];
    };
    const order = [...plan.order].sort((a, b) => {
      const [pa, pb] = [price(a), price(b)];
      return pa[0] - pb[0] || pa[1] - pb[1] || a.weight - b.weight;
    });
    return { ...plan, order };
  };

  /**
   * The OpenRouter backend pin of a model, as OpenRouter takes it.
   * @param modelId - Our model id.
   * @returns The option, or nothing.
   */
  const backendPin = (modelId: string): VendorOptions => {
    const pin = config.llm.openrouter_backends[modelId];
    return pin === undefined ? {} : { provider: { only: pin.only, allow_fallbacks: pin.allow_fallbacks } };
  };

  /**
   * What a call sends each upstream of its plan, keyed by the SDK name each reads.
   * @param plan - The plan.
   * @param modelId - Our model id.
   * @param wants - What the call asks for.
   * @returns The merged provider options.
   */
  const providerOptionsFor = (plan: RoutePlan, modelId: string, wants: CallWants): Record<string, VendorOptions> => {
    const merged: Record<string, VendorOptions> = {};
    for (const { upstream } of plan.order) {
      const vendor = vendorOf(kindOf(upstream));
      merged[vendor.sdkName] = { ...optionsFor(vendor, modelId, wants), ...(vendor.gateway ? backendPin(modelId) : {}) };
    }
    return merged;
  };

  /**
   * The cost of a finished call (design 3.6).
   * @param finished - The call's model, usage and metadata.
   * @returns Known, pending or missing.
   */
  const costOf = (finished: FinishedCall): Cost => {
    const breatic = finished.providerMetadata?.breatic as { upstream?: unknown; costRef?: unknown; cacheTtl?: unknown } | undefined;
    const upstream = typeof breatic?.upstream === "string" ? breatic.upstream : undefined;
    if (upstream === undefined || config.upstreams[upstream] === undefined) return { state: "missing", reason: "the call names no upstream" };
    if (kindOf(upstream) === "openrouter") {
      const reported = reportedCost(finished.providerMetadata);
      if (reported !== undefined) return { state: "known", usd: reported, source: "reported" };
      const ref = breatic?.costRef as { upstream?: unknown; generationId?: unknown } | undefined;
      return typeof ref?.generationId === "string"
        ? { state: "pending", lookup: { upstream: String(ref.upstream ?? upstream), generationId: ref.generationId } }
        : { state: "missing", reason: `${upstream} reported no cost and no generation id` };
    }
    const price = config.llm.prices[finished.model];
    if (price === undefined) return { state: "missing", reason: `no direct price for ${finished.model}` };
    const { usage } = finished;
    const input = usage.inputTokens ?? 0;
    const cachedInput = usage.inputTokenDetails?.cacheReadTokens ?? 0;
    const written = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
    const writePrice = (breatic?.cacheTtl === "1h" ? price.input_cache_write_1h_per_mtok : price.input_cache_write_5m_per_mtok) ?? price.input_cache_miss_per_mtok;
    const usd = ((input - cachedInput - written) * price.input_cache_miss_per_mtok
      + cachedInput * (price.input_cache_hit_per_mtok ?? price.input_cache_miss_per_mtok)
      + written * writePrice
      + (usage.outputTokens ?? 0) * price.output_per_mtok) / 1_000_000;
    return { state: "known", usd, source: "price_table" };
  };

  /**
   * The first upstream of OpenRouter's kind the route allows.
   * @param chosen - The caller's mode.
   * @returns Its name and key.
   * @throws {NoUpstreamAvailable} When none has a key.
   * @throws {UpstreamRequestRejected} When the route names an upstream of another kind.
   */
  const openrouter = (chosen: Route): { upstream: string; key: string } => {
    const names = Object.keys(config.upstreams).filter((u) => kindOf(u) === "openrouter");
    if (chosen.mode === "upstream" && !names.includes(chosen.upstream)) {
      throw new UpstreamRequestRejected(JEV_MODEL, chosen.upstream, `${chosen.upstream} does not serve ${JEV_MODEL}`);
    }
    const pool = chosen.mode === "upstream" ? [chosen.upstream] : names;
    const configured = pool.find((u) => hasKey(options.keyOf, config.upstreams[u]!.key_env));
    if (configured === undefined) {
      throw new NoUpstreamAvailable(JEV_MODEL, pool.map((u) => ({ upstream: u, kind: "missing_key", envVar: config.upstreams[u]!.key_env })));
    }
    return { upstream: configured, key: options.keyOf(config.upstreams[configured]!.key_env)! };
  };

  /**
   * Read OpenRouter's model list into the picture capability of each model.
   * @param policy - Its timeout and cache intervals.
   * @returns Once the cache clocks are updated.
   */
  const refreshCatalog = async (policy: CapabilityPolicy): Promise<void> => {
    try {
      const name = Object.keys(config.upstreams).find((u) => kindOf(u) === "openrouter");
      if (name === undefined) throw new Error("No OpenRouter upstream to read the model list from");
      const url = `${config.upstreams[name]!.base_url}/models`;
      const bounds = { replaySafe: false, deadlineAt: Date.now() + policy.timeoutMs };
      const response = await send({ url, method: "GET", headers: { accept: "application/json" } }, bounds);
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`The model list answered ${response.status}`);
      }
      const body = JSON.parse(new TextDecoder().decode(await readBody(url, response, Number.MAX_SAFE_INTEGER, policy.timeoutMs, bounds))) as unknown;
      const data = (body as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) throw new Error("The model list holds no models");
      const pictures = new Map<string, boolean>();
      for (const row of data as { id?: unknown; architecture?: { input_modalities?: unknown } }[]) {
        if (typeof row?.id !== "string") continue;
        const modalities = row.architecture?.input_modalities;
        pictures.set(row.id, Array.isArray(modalities) && modalities.includes("image"));
      }
      catalog = { pictures, freshUntil: Date.now() + policy.ttlMs, retryAfter: 0 };
    } catch {
      catalog = { ...catalog, retryAfter: Date.now() + policy.retryMs };
    }
  };

  return {
    prepare(modelId, wants, chosen = DEFAULT_ROUTE): PreparedCall {
      const route = routeOf(config.llm.routes, modelId);
      const plan = planFor(route, modelId, chosen);
      const pending = new Map<string, Cost>();
      const model = new SwitchingModel({
        modelId,
        plan,
        modelFor: (c) => modelOn(route, c.upstream, modelId),
        tracksGenerations: (upstream) => kindOf(upstream) === "openrouter",
        maxRetries: options.llmMaxRetries,
        pending,
        breatic: wants.cache === false ? {} : { cacheTtl: wants.cache },
      });
      const temperature = wants.temperature === undefined || isClaude(modelId) ? {} : { temperature: wants.temperature };
      return {
        model,
        options: { providerOptions: providerOptionsFor(plan, modelId, wants), ...temperature },
        system(parts: SystemParts): SystemModelMessage[] {
          const marks: Record<string, VendorOptions> = {};
          for (const { upstream } of plan.order) {
            const vendor = vendorOf(kindOf(upstream));
            const mark = cacheMark(vendor, modelId, wants.cache);
            if (Object.keys(mark).length > 0) marks[vendor.sdkName] = mark;
          }
          if (Object.keys(marks).length === 0) {
            return [{ role: "system", content: [parts.base, parts.project, parts.conversation].filter((p) => p !== undefined).join("\n\n") }];
          }
          const providerOptions = marks as Record<string, Record<string, JSONValue>>;
          return [
            { role: "system", content: parts.base, providerOptions },
            ...(parts.project === undefined ? [] : [{ role: "system" as const, content: parts.project, providerOptions }]),
            ...(parts.conversation === undefined ? [] : [{ role: "system" as const, content: parts.conversation }]),
          ];
        },
        pendingCosts: () => [...pending.values()],
      };
    },

    costOf,

    async understand(request, chosen = DEFAULT_ROUTE) {
      const routes = config.llm.understand_routes.some((r) => request.model.startsWith(r.prefix)) ? config.llm.understand_routes : config.llm.routes;
      const route = routeOf(routes, request.model);
      const plan = planFor(route, request.model, chosen);
      const abortSignal = untilDeadline(request.deadlineAt, request.signal);
      const content = [
        { type: "text" as const, text: options.cleanText(request.question) },
        ...request.media.flatMap((media, index) => [
          { type: "text" as const, text: `Item ${index + 1}` },
          { type: "file" as const, data: media.bytes, mediaType: media.contentType },
        ]),
      ];
      const served = await tryInOrder(plan, {
        phase: "llm_before_content",
        maxRetries: options.llmMaxRetries,
        classify: classifyLlm,
        attempt: (c) => {
          const vendor = vendorOf(kindOf(c.upstream));
          return generateText({
            model: modelOn(route, c.upstream, request.model),
            messages: [{ role: "user", content }],
            maxOutputTokens: request.maxOutputTokens,
            maxRetries: 0,
            abortSignal,
            ...(vendor.gateway ? { providerOptions: { [vendor.sdkName]: backendPin(request.model) } } : {}),
          });
        },
      });
      const result = served.value;
      const cost = costOf({
        model: request.model,
        usage: result.usage,
        providerMetadata: { ...result.providerMetadata, breatic: { upstream: served.servedBy } },
      });
      return { text: result.text, finishReason: result.finishReason, cost, upstream: served.servedBy };
    },

    async judge(request, chosen = DEFAULT_ROUTE) {
      const { upstream, key } = openrouter(chosen);
      const url = new URL(JEV_PATH, `${config.upstreams[upstream]!.base_url}/`).toString();
      const body = JSON.stringify({
        model: JEV_MODEL,
        state: cleanDeep(request.state, options.cleanText),
        questions: cleanDeep(request.questions, options.cleanText),
      });
      const bounds = { replaySafe: false, deadlineAt: Date.now() + request.budgetMs, ...(request.signal ? { signal: request.signal } : {}) };
      const response = await send({ url, method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body }, bounds);
      const text = new TextDecoder().decode(await readBody(url, response, Number.MAX_SAFE_INTEGER, Math.max(1, bounds.deadlineAt - Date.now()), bounds));
      let reported: number | undefined;
      if (response.ok) {
        try {
          const cost = (JSON.parse(text) as { usage?: { cost?: unknown } } | null)?.usage?.cost;
          reported = typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
        } catch {
          reported = undefined;
        }
      }
      const cost: Cost = reported === undefined ? { state: "missing", reason: "the decisions endpoint reported no cost" } : { state: "known", usd: reported, source: "reported" };
      return { status: response.status, body: text, cost };
    },

    async capabilities(modelId, policy, signal) {
      signal?.throwIfAborted();
      if (policy.override !== "auto") return { pictures: policy.override === "yes" };
      const now = Date.now();
      if (catalog.refreshing === undefined && now >= catalog.freshUntil && now >= catalog.retryAfter) {
        const refreshing = refreshCatalog(policy).finally(() => {
          catalog.refreshing = undefined;
        });
        catalog.refreshing = refreshing;
      }
      if (catalog.refreshing !== undefined) {
        const waiting = catalog.refreshing;
        await (signal === undefined ? waiting : Promise.race([
          waiting,
          new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true })),
        ]));
      }
      signal?.throwIfAborted();
      return { pictures: catalog.pictures.get(modelId) === true };
    },
  };
}
