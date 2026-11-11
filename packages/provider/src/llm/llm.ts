// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The LLM part of a provider instance: routing a model id to
 * its upstreams, what each upstream is sent, the cost of a finished call,
 * reading media, the decisions endpoint and the picture capability.
 */

import type { JSONValue, SystemModelMessage } from "ai";
import { candidateOf, hasKey, ProviderConfigError, type LlmRoute, type ProviderConfig } from "@provider/config/schema.js";
import type { Cost, TokenBuckets } from "@provider/cost.js";
import { BilledAnswerLost, NoUpstreamAvailable, UnderstandInterrupted, UpstreamRequestRejected } from "@provider/errors.js";
import { HttpStatus, NoAnswer } from "@provider/http/errors.js";
import { answerText, boundSignal, fetchJson, isSuccess, parsed, send } from "@provider/http/request.js";
import type { CapabilityPolicy, CallWants, FinishedCall, LlmApi, PreparedCall, SystemParts } from "@provider/llm/api.js";
import { priceAt, tokenUsd } from "@provider/llm/prices.js";
import { classifyLlm, costRefOf, InBandError, pauseBeforeRetry, SwitchingModel } from "@provider/llm/switching.js";
import { AnswerUnread, assertSucceeded, MediaReadFailed, StepRefused, UnreadableAnswer, type UnderstandSession } from "@provider/llm/understand/adapter.js";
import { understandAdapterOf } from "@provider/llm/understand/dispatch.js";
import { messagesSpeakerOf } from "@provider/llm/upstreams/messages.js";
import { cacheMark, hasLlmAdapter, isClaude, messageOf, optionsFor, vendorOf, type ModelV4, type Vendor, type VendorOptions } from "@provider/llm/vendors.js";
import type { MessagesPlan } from "@provider/messages/relay.js";
import type { ProviderOptions } from "@provider/provider.js";
import type { Failure } from "@provider/routing/decide.js";
import { planRoute, type Candidate, type Route, type RoutePlan } from "@provider/routing/route.js";
import { tryInOrder } from "@provider/routing/try-in-order.js";

const DEFAULT_ROUTE: Route = { mode: "default" };

/** One model's cached context window and its clocks. */
interface WindowEntry {
  window: number | undefined;
  freshUntil: number;
  retryAfter: number;
  refreshing: Promise<void> | undefined;
}

/**
 * Wait for the shared refresh while letting just this caller leave.
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
  /** Each model's context window and its clocks, refreshed apart from the model list. */
  const windows = new Map<string, WindowEntry>();

  /**
   * An upstream's adapter kind.
   * @param upstream - The upstream.
   * @returns Its kind.
   */
  const kindOf = (upstream: string): string => config.upstreams[upstream]!.kind;

  /**
   * An upstream's LLM adapter, when its kind has one (a media upstream has none).
   * @param upstream - The upstream.
   * @returns Its adapter, or undefined.
   */
  const llmVendorOf = (upstream: string): Vendor | undefined => (hasLlmAdapter(kindOf(upstream)) ? vendorOf(kindOf(upstream)) : undefined);

  /**
   * The id an upstream serves our model id under.
   * @param route - The route that matched.
   * @param upstream - The upstream.
   * @param modelId - Our model id.
   * @returns The upstream's id.
   */
  const vendorModelId = (route: LlmRoute, upstream: string, modelId: string): string => {
    const vendor = vendorOf(kindOf(upstream));
    return config.llm.vendor_ids[modelId]?.[upstream] ?? (vendor.gateway ? modelId : vendor.vendorId(modelId.slice(route.prefix.length)));
  };

  /**
   * The model an upstream serves our model id as.
   * @param route - The route that matched.
   * @param upstream - The upstream.
   * @param modelId - Our model id.
   * @returns Its model.
   */
  const modelOn = (route: LlmRoute, upstream: string, modelId: string): ModelV4 => {
    const decl = config.upstreams[upstream]!;
    let factory = factories.get(upstream);
    if (factory === undefined) {
      factory = vendorOf(decl.kind).build(decl, options.keyOf(decl.key_env) ?? "");
      factories.set(upstream, factory);
    }
    return factory(vendorModelId(route, upstream, modelId));
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
    const plan = planRoute(modelId, DEFAULT_ROUTE, candidates);
    return { ...plan, order: byUnitPrice(modelId, plan.order) };
  };

  /**
   * Upstreams cheapest first by unit price: input first, then output, then weight; an upstream without a price goes
   * last. One moment for the whole ranking: the direct price in effect now.
   * @param modelId - Our model id.
   * @param upstreams - The upstreams, each with its weight.
   * @returns Them in price order.
   */
  const byUnitPrice = <T extends { upstream: string; weight: number }>(modelId: string, upstreams: readonly T[]): T[] => {
    const at = Date.now();
    const direct = priceAt(config.llm.prices[modelId], at);
    /**
     * An upstream's input and output unit prices.
     * @param c - The upstream.
     * @returns Both prices; infinite when unknown.
     */
    const price = (c: T): [number, number] => {
      const listed = vendorOf(kindOf(c.upstream)).listedPrice;
      const p = listed === undefined ? direct : listed(config.llm, modelId, at);
      return p === undefined ? [Infinity, Infinity] : [p.input_cache_miss_per_mtok, p.output_per_mtok];
    };
    return [...upstreams].sort((a, b) => {
      const [pa, pb] = [price(a), price(b)];
      return pa[0] - pb[0] || pa[1] - pb[1] || a.weight - b.weight;
    });
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
   * The upstreams that serve the decisions endpoint, the one it uses first.
   * @returns Their names.
   */
  const judgeUpstreams = (): string[] => {
    const names = Object.keys(config.upstreams).filter((u) => llmVendorOf(u)?.decisions !== undefined);
    const used = names.find((u) => hasKey(options.keyOf, config.upstreams[u]!.key_env)) ?? names[0];
    return used === undefined ? [] : [used, ...names.filter((u) => u !== used)];
  };

  /**
   * What an upstream is told about where to send one call, its own routing options, or nothing.
   * @param upstream - The upstream the call goes to.
   * @param modelId - Our model id.
   * @param chosen - The caller's mode.
   * @param pinned - Whether the call is held to the model's backend pin: an understand call is, a prepared call never.
   * @returns The options, or undefined.
   */
  const routingFor = (upstream: string, modelId: string, chosen: Route, pinned: boolean): VendorOptions | undefined =>
    vendorOf(kindOf(upstream)).routing?.(config.llm, modelId, chosen.mode === "cheapest", pinned);

  /**
   * What a call sends each upstream of its plan, keyed by the SDK name each reads.
   * @param plan - The plan.
   * @param modelId - Our model id.
   * @param wants - What the call asks for.
   * @param chosen - The caller's mode.
   * @returns The merged provider options.
   */
  const providerOptionsFor = (plan: RoutePlan, modelId: string, wants: CallWants, chosen: Route): Record<string, VendorOptions> => {
    const merged: Record<string, VendorOptions> = {};
    for (const { upstream } of plan.order) {
      const vendor = vendorOf(kindOf(upstream));
      // A prepared call is never pinned to a backend: the pin is understand's alone.
      const provider = routingFor(upstream, modelId, chosen, false);
      merged[vendor.sdkName] = { ...optionsFor(vendor, modelId, wants), ...(provider === undefined ? {} : { provider }) };
    }
    return merged;
  };

  /**
   * The cost of a finished call.
   * @param finished - The call's model, usage and metadata.
   * @returns Known, pending or missing.
   */
  const costOf = (finished: FinishedCall): Cost => {
    const breatic = finished.providerMetadata?.breatic as { upstream?: unknown; costRef?: unknown; cacheTtl?: unknown; sentAt?: unknown } | undefined;
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
    const costs = llmVendorOf(upstream)?.costs;
    if (costs !== undefined) {
      const reported = costs.reported(finished.providerMetadata);
      if (reported !== undefined) return { state: "known", usd: reported, tokens, source: "reported" };
      const ref = breatic?.costRef as { upstream?: unknown; generationId?: unknown } | undefined;
      return typeof ref?.generationId === "string"
        ? { state: "pending", lookup: { upstream: String(ref.upstream ?? upstream), generationId: ref.generationId } }
        : { state: "missing", reason: `${upstream} reported no cost and no generation id`, tokens };
    }
    // Priced when the request that served the call was sent, which provider stamped on its finish.
    if (typeof breatic?.sentAt !== "number") return { state: "missing", reason: `the call of ${finished.model} on ${upstream} names no send time`, tokens };
    // A finish with no token counts at all (a stream closed before its usage chunk) is unknown, never free; one count
    // alone is priced, as Gemini answers a blocked prompt with its input tokens only.
    if (usage.inputTokens === undefined && usage.outputTokens === undefined) return { state: "missing", reason: `${upstream} reported no token usage for ${finished.model}`, tokens };
    const price = priceAt(config.llm.prices[finished.model], breatic.sentAt);
    if (price === undefined) return { state: "missing", reason: `no direct price for ${finished.model}`, tokens };
    const written = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
    const usd = tokenUsd(price, { input: tokens.input, cachedInput: tokens.cachedInput, written, output: usage.outputTokens ?? 0 }, breatic?.cacheTtl);
    return { state: "known", usd, tokens, source: "price_table" };
  };

  /**
   * The failure class of an understand attempt's error: a vendor's refusal forms are read
   * only on its model answers, never on a preparatory step's.
   * @param error - What the attempt threw.
   * @param upstream - The upstream it was on.
   * @returns Its class, or null.
   */
  const understandFailure = (error: unknown, upstream: string): Failure | null => {
    // The caller's reader failed: the upstream was never asked, so the call stops here and moves on nowhere.
    if (error instanceof MediaReadFailed) return null;
    return classifyLlm(error, error instanceof StepRefused ? undefined : vendorOf(kindOf(upstream)));
  };

  /**
   * How an understand call ended, when it did not answer: a refusal the route
   * stopped on becomes UpstreamRequestRejected with the upstream's status (an error in a 2xx
   * answer with no code of its own takes that answer's status), an unusable answer one with
   * none, running out of upstreams NoUpstreamAvailable, anything else UnderstandInterrupted.
   * Each carries what every billed answer cost, recorded as it arrived.
   * @param model - Our model id.
   * @param upstream - The upstream that answered last.
   * @param error - What the call threw.
   * @param billed - What the billed answers cost, in order.
   * @returns The error to throw.
   */
  const understandEnding = (model: string, upstream: string | undefined, error: unknown, billed: Cost[]): Error => {
    if (error instanceof NoUpstreamAvailable) return new NoUpstreamAvailable(error.model, error.reasons, billed);
    if (upstream === undefined) return new UnderstandInterrupted(model, billed, error);
    if (error instanceof MediaReadFailed) return new UnderstandInterrupted(model, billed, error.cause);
    /**
     * What the refusal was about, read the answering upstream's way from its error value.
     * @param value - The upstream's error value.
     * @returns The reason, when it says one.
     */
    const reasonOf = (value: unknown): { reason?: "content_blocked" } =>
      (understandAdapterOf(kindOf(upstream)).contentBlocked?.(value) === true ? { reason: "content_blocked" } : {});
    if (error instanceof UnreadableAnswer) return new UpstreamRequestRejected(model, upstream, error.message, billed, { cause: error });
    const failure = understandFailure(error, upstream);
    if (error instanceof InBandError) {
      const status = failure?.kind === "http_status" ? failure.status : error.answerStatus;
      if (status === undefined) return new UnderstandInterrupted(model, billed, error);
      const said = (error.error as { message?: unknown } | null)?.message;
      return new UpstreamRequestRejected(model, upstream, typeof said === "string" ? said : error.message, billed, { status, cause: error, ...reasonOf(error.error) });
    }
    if (failure?.kind !== "http_status") return new UnderstandInterrupted(model, billed, error);
    // The refused answer's whole text, a model answer's or an upload step's.
    const refused = parsed(error instanceof HttpStatus ? error.body : undefined);
    const said = messageOf(refused);
    const value = (refused as { error?: unknown } | null | undefined)?.error;
    return new UpstreamRequestRejected(model, upstream, said !== "" ? said : (error as Error).message, billed, { status: failure.status, cause: error, ...reasonOf(value) });
  };

  /**
   * What an answer that served nothing cost, read from its body: the cost it
   * reported, else a lookup by the generation it names, else missing for a 2xx.
   * @param upstream - The upstream that answered.
   * @param status - The answer's status.
   * @param text - The answer's body.
   * @returns The cost, or undefined for a refusal status whose body names none.
   */
  const answerCost = (upstream: string, status: number, text: string | undefined): Cost | undefined => {
    const costs = vendorOf(kindOf(upstream)).costs;
    const body = costs?.ofBody(parsed(text)) ?? {};
    if (body.cost !== undefined) return { state: "known", usd: body.cost, source: "reported" };
    const ref = costRefOf(upstream, costs, body.id, undefined);
    if (ref !== undefined) return { state: "pending", lookup: ref };
    return isSuccess(status) ? { state: "missing", reason: `${upstream} answered with no cost and no generation id` } : undefined;
  };

  /**
   * The first upstream serving the decisions endpoint that the route allows.
   * @param chosen - The caller's mode.
   * @returns Its name, key and the endpoint it serves.
   * @throws {NoUpstreamAvailable} When none has a key.
   * @throws {UpstreamRequestRejected} When the route names an upstream that does not serve it.
   */
  const decisionsUpstream = (chosen: Route): { upstream: string; key: string; decisions: NonNullable<Vendor["decisions"]> } => {
    const names = judgeUpstreams();
    // The endpoint's model, named in an error before an upstream is chosen.
    const model = names.length === 0 ? "the decisions endpoint" : llmVendorOf(names[0]!)!.decisions!.model;
    if (chosen.mode === "upstream" && !names.includes(chosen.upstream)) {
      throw new UpstreamRequestRejected(model, chosen.upstream, `${chosen.upstream} does not serve ${model}`);
    }
    const pool = chosen.mode === "upstream" ? [chosen.upstream] : names;
    const configured = pool.find((u) => hasKey(options.keyOf, config.upstreams[u]!.key_env));
    if (configured === undefined) {
      throw new NoUpstreamAvailable(model, pool.map((u) => ({ upstream: u, kind: "missing_key", envVar: config.upstreams[u]!.key_env })));
    }
    return { upstream: configured, key: options.keyOf(config.upstreams[configured]!.key_env)!, decisions: llmVendorOf(configured)!.decisions! };
  };

  /**
   * Read the model list of the first upstream that has one into the picture capability of each model.
   * @param policy - Its timeout and cache intervals.
   * @returns Once the cache clocks are updated.
   */
  const refreshCatalog = async (policy: CapabilityPolicy): Promise<void> => {
    try {
      const name = Object.keys(config.upstreams).find((u) => llmVendorOf(u)?.catalog !== undefined);
      if (name === undefined) throw new Error("No upstream to read the model list from");
      const lister = llmVendorOf(name)!.catalog!;
      const body = await fetchJson(
        { url: lister.url(config.upstreams[name]!), method: "GET", headers: { accept: "application/json" } },
        { replaySafe: true, deadlineAt: Date.now() + policy.timeoutMs, maxBodyBytes: Number.MAX_SAFE_INTEGER, idleMs: policy.timeoutMs },
      );
      const pictures = lister.read(body);
      if (pictures === undefined) throw new Error("The model list holds no models");
      catalog = { pictures, freshUntil: Date.now() + policy.ttlMs, retryAfter: 0 };
    } catch {
      catalog = { ...catalog, retryAfter: Date.now() + policy.retryMs };
    }
  };

  /**
   * Read one model's endpoint list, at the first upstream that has a model list, into its context window. A failure
   * keeps the last window and cools down.
   * @param modelId - Our model id.
   * @param entry - Its cache entry, updated in place.
   * @param policy - Its timeout and cache intervals.
   * @returns Once the entry's clocks are updated.
   */
  const refreshWindow = async (modelId: string, entry: WindowEntry, policy: CapabilityPolicy): Promise<void> => {
    try {
      const name = Object.keys(config.upstreams).find((u) => llmVendorOf(u)?.catalog !== undefined);
      if (name === undefined) throw new Error("No upstream to read the endpoint list from");
      const reader = llmVendorOf(name)!.catalog!.contextWindow;
      const body = await fetchJson(
        { url: reader.url(config.upstreams[name]!, modelId), method: "GET", headers: { accept: "application/json" } },
        { replaySafe: true, deadlineAt: Date.now() + policy.timeoutMs, maxBodyBytes: Number.MAX_SAFE_INTEGER, idleMs: policy.timeoutMs },
      );
      const window = reader.read(body);
      if (window === undefined) throw new Error("No endpoint of the model states a context length");
      Object.assign(entry, { window, freshUntil: Date.now() + policy.ttlMs, retryAfter: 0 });
    } catch {
      entry.retryAfter = Date.now() + policy.retryMs;
    }
  };

  /**
   * One model's context window, refreshed when its cache is stale and not cooling down.
   * @param modelId - Our model id.
   * @param policy - Its timeout and cache intervals.
   * @param signal - The waiting caller's stop signal.
   * @returns The window, or undefined when it has never been read.
   * @throws {unknown} The stop signal's reason when the caller leaves.
   */
  const contextWindowOf = async (modelId: string, policy: CapabilityPolicy, signal?: AbortSignal): Promise<number | undefined> => {
    let entry = windows.get(modelId);
    if (entry === undefined) {
      entry = { window: undefined, freshUntil: 0, retryAfter: 0, refreshing: undefined };
      windows.set(modelId, entry);
    }
    const now = Date.now();
    if (now >= entry.freshUntil && now >= entry.retryAfter) {
      const one = entry;
      one.refreshing ??= refreshWindow(modelId, one, policy).finally(() => {
        one.refreshing = undefined;
      });
    }
    if (entry.refreshing !== undefined) await waitForCatalog(entry.refreshing, signal);
    return entry.window;
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
        maxRetries: options.llmMaxRetries,
        pending,
        breatic: wants.cache === false ? {} : { cacheTtl: wants.cache },
      });
      const temperature = wants.temperature === undefined || isClaude(modelId) ? {} : { temperature: wants.temperature };
      return {
        model,
        // provider retries and switches itself; an AI SDK retry around it would resend what it gave up on.
        options: { providerOptions: providerOptionsFor(plan, modelId, wants, chosen), maxRetries: 0, ...temperature },
        system(parts: SystemParts): SystemModelMessage[] {
          const marks: Record<string, VendorOptions> = {};
          for (const { upstream } of plan.order) {
            const vendor = vendorOf(kindOf(upstream));
            const mark = cacheMark(vendor, modelId, wants.cache);
            if (Object.keys(mark).length > 0) marks[vendor.sdkName] = mark;
          }
          if (Object.keys(marks).length === 0) {
            return [{ role: "system", content: [parts.base, parts.project, parts.conversation, parts.projectInstructions].filter((p) => p !== undefined).join("\n\n") }];
          }
          const providerOptions = marks as Record<string, Record<string, JSONValue>>;
          return [
            { role: "system", content: parts.base, providerOptions },
            ...(parts.project === undefined ? [] : [{ role: "system" as const, content: parts.project, providerOptions }]),
            ...(parts.conversation === undefined ? [] : [{ role: "system" as const, content: parts.conversation }]),
            ...(parts.projectInstructions === undefined ? [] : [{ role: "system" as const, content: parts.projectInstructions }]),
          ];
        },
        pendingCosts: () => [...pending.values()],
      };
    },

    costOf,

    async understand(request, chosen = DEFAULT_ROUTE) {
      const route = routeOf(config.llm.understand_routes, request.model);
      const plan = planFor(route, request.model, chosen);
      const { signal, dispose } = boundSignal({ deadlineAt: request.deadlineAt, ...(request.signal ? { signal: request.signal } : {}) });
      const question = options.cleanText(request.question);
      let answering: string | undefined;
      // What every billed answer cost, in the order they arrived.
      const billed: Cost[] = [];
      const session: UnderstandSession = { uploads: new Map(), cleanups: [] };
      try {
        const served = await tryInOrder(plan, {
          phase: "llm_before_content",
          maxRetries: options.llmMaxRetries,
          classify: (error, c) => understandFailure(error, c.upstream),
          pause: (error, retry) => pauseBeforeRetry(error, retry, signal),
          attempt: async (c) => {
            answering = c.upstream;
            const decl = config.upstreams[c.upstream]!;
            const adapter = understandAdapterOf(decl.kind);
            // Held to the model's backend pin, which is understand's alone, and in cheapest mode sorted by price as a prepared call is.
            const provider = routingFor(c.upstream, request.model, chosen, true);
            let answered;
            try {
              answered = await adapter.ask({
                decl,
                key: options.keyOf(decl.key_env) ?? "",
                modelId: vendorModelId(route, c.upstream, request.model),
                question,
                media: request.media,
                maxOutputTokens: request.maxOutputTokens,
                ...(provider === undefined ? {} : { provider }),
                deadlineAt: request.deadlineAt,
                signal,
                inlineMaxBytes: config.llm.gemini_inline_max_bytes,
                filePollMs: config.llm.gemini_file_poll_ms,
                session,
              });
            } catch (error) {
              // A 2xx whose body was lost was still billed, for an amount nobody can now read.
              if (error instanceof AnswerUnread) {
                billed.push({ state: "missing", reason: `${c.upstream} answered ${error.status} and its body could not be read` });
              }
              throw error;
            }
            // Every billed answer is recorded as it arrives, before the route judges it.
            /**
             * Record what an answer that served nothing carried: a refusal that names a cost or a
             * generation was billed; an unusable 2xx always was, never a price-table guess.
             */
            const recordUnserved = (): void => {
              const cost = answerCost(c.upstream, answered.status, answered.text);
              if (cost !== undefined) billed.push(cost);
            };
            if (!isSuccess(answered.status)) {
              recordUnserved();
              assertSucceeded(answered);
            }
            const reading = adapter.read(answered.body);
            if ("unreadable" in reading) {
              recordUnserved();
              throw new UnreadableAnswer(reading.unreadable);
            }
            const { usage, providerMetadata, generationId, missing } = adapter.billing(answered.body);
            const costRef = costRefOf(c.upstream, vendorOf(kindOf(c.upstream)).costs, generationId, providerMetadata);
            billed.push(missing !== undefined
              ? { state: "missing", reason: missing }
              : costOf({ model: request.model, usage, providerMetadata: { ...providerMetadata, breatic: { upstream: c.upstream, sentAt: answered.sentAt, ...(costRef ? { costRef } : {}) } } }));
            if ("error" in reading) throw new InBandError(reading.error, answered.status);
            return reading;
          },
        });
        return { text: served.value.text, finishReason: served.value.finishReason, costs: [...billed], upstream: served.servedBy };
      } catch (error) {
        throw understandEnding(request.model, answering, error, billed);
      } finally {
        dispose();
        for (const cleanup of session.cleanups) cleanup();
      }
    },

    messagesPlan(modelId, chosen = DEFAULT_ROUTE): MessagesPlan {
      const route = routeOf(config.llm.routes, modelId);
      // Every upstream of the route that takes a Messages request, whatever keys this process holds: the Worker that
      // sends the call reads its own.
      const speaking = route.upstreams.filter(({ upstream }) => messagesSpeakerOf(kindOf(upstream)) !== undefined);
      if (chosen.mode === "upstream" && !speaking.some(({ upstream }) => upstream === chosen.upstream)) {
        throw new UpstreamRequestRejected(modelId, chosen.upstream, `${chosen.upstream} takes no Messages request for ${modelId}`);
      }
      const picked = chosen.mode === "upstream"
        ? speaking.filter(({ upstream }) => upstream === chosen.upstream)
        : chosen.mode === "cheapest" ? byUnitPrice(modelId, speaking) : speaking;
      if (picked.length === 0) {
        throw new NoUpstreamAvailable(modelId, route.upstreams.map(({ upstream }) => ({ upstream, kind: "failed", failure: "takes no Messages request" })));
      }
      return {
        model: modelId,
        candidates: picked.map(({ upstream }) => {
          const decl = config.upstreams[upstream]!;
          // An upstream that reports no cost of its own is priced from the model's direct prices.
          const prices = vendorOf(decl.kind).costs === undefined ? config.llm.prices[modelId] : undefined;
          return {
            upstream,
            kind: decl.kind,
            baseUrl: decl.base_url,
            vendorModel: vendorModelId(route, upstream, modelId),
            keyEnv: decl.key_env,
            ...(prices === undefined ? {} : { prices }),
          };
        }),
      };
    },

    async judge(request, chosen = DEFAULT_ROUTE) {
      const { upstream, key, decisions } = decisionsUpstream(chosen);
      const url = decisions.url(config.upstreams[upstream]!);
      const body = JSON.stringify({
        model: decisions.model,
        state: cleanDeep(request.state, options.cleanText),
        questions: cleanDeep(request.questions, options.cleanText),
      });
      const bounds = { replaySafe: false, deadlineAt: Date.now() + request.budgetMs, ...(request.signal ? { signal: request.signal } : {}) };
      const response = await send({ url, method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body }, bounds);
      let text: string;
      try {
        text = await answerText(url, response, Number.MAX_SAFE_INTEGER, Math.max(1, bounds.deadlineAt - Date.now()), bounds);
      } catch (error) {
        // A 2xx was billed though its body was lost; a refusal's lost body reads as no words.
        throw new NoAnswer(url, new BilledAnswerLost(`the decisions endpoint answered ${response.status} and its body could not be read`, error));
      }
      if (!isSuccess(response.status)) return { status: response.status, body: text };
      const reported = vendorOf(kindOf(upstream)).costs?.ofBody(parsed(text)).cost;
      const cost: Cost = reported === undefined ? { state: "missing", reason: "the decisions endpoint reported no cost" } : { state: "known", usd: reported, source: "reported" };
      return { status: response.status, body: text, cost };
    },

    availability(modelId, use) {
      const candidates = use === "judge"
        ? judgeUpstreams().map((upstream, weight) => candidateOf(config, upstream, weight, options.keyOf))
        : candidatesOn(routeOf(use === "call" ? config.llm.routes : config.llm.understand_routes, modelId));
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
      /**
       * Whether the model takes pictures: the deployment's override, else the model list.
       * @returns The answer.
       */
      const pictures = async (): Promise<boolean> => {
        if (policy.override !== "auto") return policy.override === "yes";
        const now = Date.now();
        if (now >= catalog.freshUntil && now >= catalog.retryAfter) {
          refreshing ??= refreshCatalog(policy).finally(() => {
            refreshing = undefined;
          });
          await waitForCatalog(refreshing, signal);
        }
        return catalog.pictures.get(modelId) === true;
      };
      const [takesPictures, contextWindow] = await Promise.all([pictures(), contextWindowOf(modelId, policy, signal)]);
      signal?.throwIfAborted();
      return { pictures: takesPictures, ...(contextWindow === undefined ? {} : { contextWindow }) };
    },
  };
}
