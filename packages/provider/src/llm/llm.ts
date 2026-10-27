// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The LLM part of a provider instance (design 3.5): routing a model id to
 * its upstreams, what each upstream is sent, the cost of a finished call,
 * reading media, the decisions endpoint and the picture capability.
 */

import { APICallError, generateText, type JSONValue, type SystemModelMessage } from "ai";
import { candidateOf, hasKey, ProviderConfigError, type LlmRoute, type ProviderConfig } from "@provider/config/schema.js";
import type { Cost, TokenBuckets } from "@provider/cost.js";
import { NoUpstreamAvailable, UpstreamRequestRejected } from "@provider/errors.js";
import { aiSdkFetch, boundSignal, readBody, send } from "@provider/http/request.js";
import type { CapabilityPolicy, CallWants, FinishedCall, LlmApi, PreparedCall, SystemParts } from "@provider/llm/api.js";
import { classifyLlm, costRefOf, InBandError, parsed, pauseBeforeRetry, reportedCost, SwitchingModel, usdOf } from "@provider/llm/switching.js";
import { cacheMark, isClaude, optionsFor, vendorOf, type ModelV4, type VendorOptions } from "@provider/llm/vendors.js";
import type { ProviderOptions } from "@provider/provider.js";
import { decide } from "@provider/routing/decide.js";
import { planRoute, type Candidate, type Route, type RoutePlan } from "@provider/routing/route.js";
import { tryInOrder } from "@provider/routing/try-in-order.js";

/** The decisions endpoint's model (JEV), pinned like domain's `JEV_PINS`. */
const JEV_MODEL = "typesafe/jev-1.13";
/** The decisions endpoint, beside the OpenRouter API base. */
const JEV_PATH = "../alpha/decisions";
const DEFAULT_ROUTE: Route = { mode: "default" };

/**
 * Wait for the shared refresh while letting just this caller leave
 * (ported from domain's agent/model-picture-capability.ts).
 * @param pending - The shared request, which this function never cancels.
 * @param signal - This caller's stop signal.
 * @returns Once the refresh settles, for a caller still waiting.
 * @throws {unknown} The stop signal's reason when the caller leaves.
 */
async function waitForCatalog(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (signal === undefined) return pending;
  return new Promise<void>((resolve, reject) => {
    /**
     * Reject only this wait and leave the refresh alive.
     */
    const stop = (): void => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
    void pending.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", stop);
    });
    if (signal.aborted) stop();
  });
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
  let refreshing: Promise<void> | undefined;
  let catalog: { pictures: ReadonlyMap<string, boolean>; freshUntil: number; retryAfter: number } = {
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
   * @param fetch - A fetch for this call only; the upstream's shared factory is used without one.
   * @returns Its model.
   */
  const modelOn = (route: LlmRoute, upstream: string, modelId: string, fetch?: typeof globalThis.fetch): ModelV4 => {
    const decl = config.upstreams[upstream]!;
    const vendor = vendorOf(decl.kind);
    const key = options.keyOf(decl.key_env) ?? "";
    let factory = fetch === undefined ? factories.get(upstream) : vendor.build(decl, key, fetch);
    if (factory === undefined) {
      factory = vendor.build(decl, key, aiSdkFetch);
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
    const candidates = candidatesOn(route);
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
   * A route's upstreams as routing candidates, in the order the route holds them:
   * lowest weight first, since parseProviderConfig sorts every route when it loads.
   * @param route - The route.
   * @returns One candidate per upstream.
   */
  const candidatesOn = (route: LlmRoute): Candidate[] =>
    route.upstreams.map(({ upstream, weight }) => candidateOf(config, upstream, weight, options.keyOf));

  /**
   * The routes an understand call of a model uses: the understanding routes when one matches, else the call routes.
   * @param modelId - Our model id.
   * @returns The routes.
   */
  const understandRoutes = (modelId: string): readonly LlmRoute[] =>
    config.llm.understand_routes.some((r) => modelId.startsWith(r.prefix)) ? config.llm.understand_routes : config.llm.routes;

  /**
   * The OpenRouter-kind upstreams the decisions endpoint can use, the one it uses first.
   * @returns Their names.
   */
  const judgeUpstreams = (): string[] => {
    const names = Object.keys(config.upstreams).filter((u) => kindOf(u) === "openrouter");
    const used = names.find((u) => hasKey(options.keyOf, config.upstreams[u]!.key_env)) ?? names[0];
    return used === undefined ? [] : [used, ...names.filter((u) => u !== used)];
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
    const { usage } = finished;
    // Split as domain's usage-cost bucketsOf splits it; reasoning is part of output.
    const tokens: TokenBuckets = {
      input: usage.inputTokens ?? 0,
      cachedInput: usage.inputTokenDetails?.cacheReadTokens ?? 0,
      output: usage.outputTokens ?? 0,
      reasoning: usage.outputTokenDetails?.reasoningTokens ?? 0,
    };
    const upstream = typeof breatic?.upstream === "string" ? breatic.upstream : undefined;
    if (upstream === undefined || config.upstreams[upstream] === undefined) return { state: "missing", reason: "the call names no upstream", tokens };
    if (kindOf(upstream) === "openrouter") {
      const reported = reportedCost(finished.providerMetadata);
      if (reported !== undefined) return { state: "known", usd: reported, tokens, source: "reported" };
      const ref = breatic?.costRef as { upstream?: unknown; generationId?: unknown } | undefined;
      return typeof ref?.generationId === "string"
        ? { state: "pending", lookup: { upstream: String(ref.upstream ?? upstream), generationId: ref.generationId } }
        : { state: "missing", reason: `${upstream} reported no cost and no generation id`, tokens };
    }
    const price = config.llm.prices[finished.model];
    if (price === undefined) return { state: "missing", reason: `no direct price for ${finished.model}`, tokens };
    const { input, cachedInput } = tokens;
    const written = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
    const writePrice = (breatic?.cacheTtl === "1h" ? price.input_cache_write_1h_per_mtok : price.input_cache_write_5m_per_mtok) ?? price.input_cache_miss_per_mtok;
    const usd = ((input - cachedInput - written) * price.input_cache_miss_per_mtok
      + cachedInput * (price.input_cache_hit_per_mtok ?? price.input_cache_miss_per_mtok)
      + written * writePrice
      + (usage.outputTokens ?? 0) * price.output_per_mtok) / 1_000_000;
    return { state: "known", usd, tokens, source: "price_table" };
  };

  /**
   * An understand call the route stopped on, as the refusal it is, carrying what the
   * refused answer cost: the upstream may bill it, so it is read before the refusal is
   * judged, as domain's understand did.
   * @param model - Our model id.
   * @param upstream - The upstream that answered last.
   * @param error - What the call threw.
   * @param answerBody - The text of the last answer, when the SDK error kept no body.
   * @param billed - The billed answers the call moved past.
   * @returns UpstreamRequestRejected for an answered refusal, NoUpstreamAvailable carrying the billed answers, or the error itself.
   */
  const refusedCall = (model: string, upstream: string | undefined, error: unknown, answerBody: string | undefined, billed: Cost[]): unknown => {
    if (error instanceof NoUpstreamAvailable) return new NoUpstreamAvailable(error.model, error.reasons, billed);
    // The status the answer came with: an error on a 200's choice came with a 200.
    const status = APICallError.isInstance(error) ? error.statusCode : error instanceof InBandError ? 200 : undefined;
    if (upstream === undefined || status === undefined) return error;
    const failure = classifyLlm(error, vendorOf(kindOf(upstream)));
    if (failure?.kind !== "http_status" || decide(failure, "llm_before_content", 0, 0) !== "stop") return error;
    const said = error instanceof InBandError ? (error.error as { message?: unknown } | null)?.message : undefined;
    const message = typeof said === "string" ? said : (error as Error).message;
    // A choice error's answer was costed where it was read; an answer refused by its status is costed here.
    if (error instanceof InBandError) return new UpstreamRequestRejected(model, upstream, message, billed);
    const cost = answerCost(upstream, status, APICallError.isInstance(error) ? (error.responseBody ?? answerBody) : answerBody);
    return new UpstreamRequestRejected(model, upstream, message, cost === undefined ? billed : [...billed, cost]);
  };

  /**
   * What an answer that served nothing cost, read from its body (design 3.5): the cost it
   * reported, else a lookup by an OpenRouter generation id, else missing for a 2xx.
   * @param upstream - The upstream that answered.
   * @param status - The answer's status.
   * @param text - The answer's body.
   * @returns The cost, or undefined for a refusal status whose body names none.
   */
  const answerCost = (upstream: string, status: number, text: string | undefined): Cost | undefined => {
    const body = parsed(text) as { id?: unknown; usage?: { cost?: unknown } } | null | undefined;
    const reported = usdOf(body?.usage?.cost);
    if (reported !== undefined) return { state: "known", usd: reported, source: "reported" };
    const ref = costRefOf(upstream, kindOf(upstream) === "openrouter", body?.id, undefined);
    if (ref !== undefined) return { state: "pending", lookup: ref };
    return status >= 200 && status < 300 ? { state: "missing", reason: `${upstream} answered with no cost and no generation id` } : undefined;
  };

  /**
   * The first upstream of OpenRouter's kind the route allows.
   * @param chosen - The caller's mode.
   * @returns Its name and key.
   * @throws {NoUpstreamAvailable} When none has a key.
   * @throws {UpstreamRequestRejected} When the route names an upstream of another kind.
   */
  const openrouter = (chosen: Route): { upstream: string; key: string } => {
    const names = judgeUpstreams();
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
      const bounds = { replaySafe: true, deadlineAt: Date.now() + policy.timeoutMs };
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
        vendorFor: (upstream) => vendorOf(kindOf(upstream)),
        tracksGenerations: (upstream) => kindOf(upstream) === "openrouter",
        maxRetries: options.llmMaxRetries,
        pending,
        breatic: wants.cache === false ? {} : { cacheTtl: wants.cache },
      });
      const temperature = wants.temperature === undefined || isClaude(modelId) ? {} : { temperature: wants.temperature };
      return {
        model,
        // provider retries and switches itself; an AI SDK retry around it would resend what it gave up on.
        options: { providerOptions: providerOptionsFor(plan, modelId, wants), maxRetries: 0, ...temperature },
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
      const route = routeOf(understandRoutes(request.model), request.model);
      const plan = planFor(route, request.model, chosen);
      const { signal: abortSignal, dispose } = boundSignal({ deadlineAt: request.deadlineAt, ...(request.signal ? { signal: request.signal } : {}) });
      const content = [
        { type: "text" as const, text: options.cleanText(request.question) },
        ...request.media.flatMap((media, index) => [
          { type: "text" as const, text: `Item ${index + 1}` },
          { type: "file" as const, data: media.bytes, mediaType: media.contentType },
        ]),
      ];
      let answering: string | undefined;
      // Answers an upstream billed that the call moved past.
      const billed: Cost[] = [];
      // The body of the last answer: a refused call may be billed, and its SDK error keeps only part of it.
      let lastBody: string | undefined;
      /**
       * provider's fetch, keeping the text of each answer for a refusal's cost.
       * @param input - The request.
       * @param init - Its options.
       * @returns The response, its body still readable.
       * @throws {NotSent | NoAnswer} As provider's fetch throws.
       */
      const keepingBody = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const response = await aiSdkFetch(input, init);
        lastBody = await response.clone().text().catch(() => undefined);
        return response;
      };
      const served = await tryInOrder(plan, {
        phase: "llm_before_content",
        maxRetries: options.llmMaxRetries,
        classify: (error, c) => classifyLlm(error, vendorOf(kindOf(c.upstream))),
        pause: (error, retry) => pauseBeforeRetry(error, retry, abortSignal),
        attempt: async (c) => {
          answering = c.upstream;
          lastBody = undefined;
          const vendor = vendorOf(kindOf(c.upstream));
          // A gateway answers 200 with an error on the choice when the model failed while
          // producing output. With nothing written it is judged by its code like any status,
          // whether or not its SDK could read the rest of the answer; with words already
          // written it is a stop, answered as it is.
          /**
           * The error on the kept answer's first choice, when that choice wrote nothing.
           * @returns The error, or undefined.
           */
          const choiceError = (): unknown => {
            if (!vendor.gateway) return undefined;
            const choice = (parsed(lastBody) as { choices?: { error?: unknown; message?: { content?: unknown } }[] } | null | undefined)?.choices?.[0];
            const written = choice?.message?.content;
            return typeof written === "string" && written !== "" ? undefined : (choice?.error ?? undefined);
          };
          /**
           * Cost the answer and throw its choice error, to be judged by its code.
           * @param error - The choice's error.
           * @throws {InBandError} Always.
           */
          const throwChoiceError = (error: unknown): never => {
            const cost = answerCost(c.upstream, 200, lastBody);
            if (cost !== undefined) billed.push(cost);
            throw new InBandError(error);
          };
          let result;
          try {
            result = await generateText({
              model: modelOn(route, c.upstream, request.model, keepingBody),
              messages: [{ role: "user", content }],
              maxOutputTokens: request.maxOutputTokens,
              maxRetries: 0,
              abortSignal,
              ...(vendor.gateway ? { providerOptions: { [vendor.sdkName]: backendPin(request.model) } } : {}),
            });
          } catch (error) {
            const carried = choiceError();
            if (carried !== undefined && carried !== null) throwChoiceError(carried);
            throw error;
          }
          const carried = result.text === "" ? choiceError() : undefined;
          if (carried !== undefined && carried !== null) throwChoiceError(carried);
          return result;
        },
      }).catch((error: unknown) => {
        throw refusedCall(request.model, answering, error, lastBody, billed);
      }).finally(dispose);
      const result = served.value;
      const generationId = result.response.id;
      const ref = costRefOf(served.servedBy, kindOf(served.servedBy) === "openrouter", generationId, result.providerMetadata);
      const costRef = ref === undefined ? {} : { costRef: ref };
      const cost = costOf({
        model: request.model,
        usage: result.usage,
        providerMetadata: { ...result.providerMetadata, breatic: { upstream: served.servedBy, ...costRef } },
      });
      return { text: result.text, finishReason: result.finishReason, costs: [...billed, cost], upstream: served.servedBy };
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
      const reported = response.ok ? usdOf((parsed(text) as { usage?: { cost?: unknown } } | null | undefined)?.usage?.cost) : undefined;
      const cost: Cost = reported === undefined ? { state: "missing", reason: "the decisions endpoint reported no cost" } : { state: "known", usd: reported, source: "reported" };
      return { status: response.status, body: text, cost };
    },

    availability(modelId, use) {
      const candidates = use === "judge"
        ? judgeUpstreams().map((upstream, weight) => candidateOf(config, upstream, weight, options.keyOf))
        : candidatesOn(routeOf(use === "call" ? config.llm.routes : understandRoutes(modelId), modelId));
      return { upstreams: candidates.map(({ upstream, weight, configured, envVar }) => ({ upstream, weight, configured, envVar })) };
    },

    assertModelsPriced(models) {
      const problems = new Set<string>();
      for (const model of models) {
        const routes = [config.llm.routes, config.llm.understand_routes].flatMap((list) => list.find((r) => model.startsWith(r.prefix)) ?? []);
        for (const { upstream } of routes.flatMap((r) => r.upstreams)) {
          const decl = config.upstreams[upstream]!;
          if (vendorOf(decl.kind).gateway || !hasKey(options.keyOf, decl.key_env) || config.llm.prices[model] !== undefined) continue;
          problems.add(`${model}: reached directly on ${upstream} with no token price in llm.yaml`);
        }
      }
      if (problems.size > 0) throw new ProviderConfigError([...problems]);
    },

    async capabilities(modelId, policy, signal) {
      signal?.throwIfAborted();
      if (policy.override !== "auto") return { pictures: policy.override === "yes" };
      const now = Date.now();
      if (now >= catalog.freshUntil && now >= catalog.retryAfter) {
        refreshing ??= refreshCatalog(policy).finally(() => {
          refreshing = undefined;
        });
        await waitForCatalog(refreshing, signal);
      } else if (refreshing !== undefined) {
        await waitForCatalog(refreshing, signal);
      }
      signal?.throwIfAborted();
      return { pictures: catalog.pictures.get(modelId) === true };
    },
  };
}
