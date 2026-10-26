// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { candidatesOf, parseProviderConfig, type MediaBinding, type ProviderConfig } from "@provider/config/schema.js";
import type { Cost } from "@provider/cost.js";
import { DeadlinePassed, NoUpstreamAvailable, SendNotAccepted, UpstreamRequestRejected, UpstreamTaskFailed, type UnavailableReason } from "@provider/errors.js";
import { Aborted, HttpStatus, NoAnswer, NotSent } from "@provider/http/errors.js";
import { fetchMedia, MediaRefused } from "@provider/http/fetch-media.js";
import { ask, billed, gone, modelNotFound, submit, type Reach, type RequestBounds } from "@provider/media/wavespeed/adapter.js";
import { buildBody } from "@provider/media/wavespeed/body.js";
import { orderByPrice } from "@provider/pricing/estimate.js";
import type { Provider } from "@provider/provider.js";
import { decide, type Failure } from "@provider/routing/decide.js";
import { planRoute, type Candidate, type Route, type RoutePlan } from "@provider/routing/route.js";

/**
 * Everything provider knows about one media run. The caller stores it as JSON
 * and hands it back; only `version` is the caller's to read, for a
 * compare-and-set write (design 12.2).
 */
export interface MediaTicket {
  readonly version: number;
  readonly [key: string]: unknown;
}

/** What one step of a run does. */
export type StepKind = "generate" | "upload_reference" | "upload_melody" | "vocal" | "voice" | "speak" | "element" | "describe";

/** One output of a finished run (design 3.4, S5). */
export type MediaOutput =
  | { kind: "url"; url: string; contentType?: string }
  | { kind: "bytes"; bytes: Uint8Array; contentType: string };

/** One cached clone, as the caller stores it. */
export interface MediaClone {
  upstream: string;
  kind: "voice" | "vocal" | "element";
  /** The source asset's sha256, with a suffix for an element. */
  sourceKey: string;
  upstreamId: string;
}

/** Something provider wants the caller to log (design 3.7). */
export interface MediaWarning {
  code: string;
  detail: Record<string, unknown>;
}

/** What every answer carries. */
interface AnswerCommon {
  /** Clones this answer made. */
  clones: MediaClone[];
  /** Cached clones the upstream said are gone. */
  retiredClones: MediaClone[];
  warnings: MediaWarning[];
}

/** Where a run is after one call (design 3.4). */
export type MediaAnswer = AnswerCommon &
  (
    | { state: "send"; ticket: MediaTicket; step: { kind: StepKind } }
    | { state: "running"; ticket: MediaTicket; askAgainAt: number }
    | { state: "done"; outputs: MediaOutput[]; costs: Cost[]; servedBy: string }
    | { state: "failed"; reason: Error; costs: Cost[] }
  );

/** What the run is asked to make. */
export interface MediaInput {
  prompt: string;
  /** Our params, in our names. */
  params: Record<string, unknown>;
}

/** What `plan` needs beyond the input. */
export interface PlanOptions {
  /** Unique per task; client keys are derived from it. */
  idempotencyKey: string;
  /** Source url to the sha256 of the asset behind it, from the caller's asset table. */
  sourceKeys: Record<string, string>;
  /** Live clones of these sources on every upstream. */
  clones: MediaClone[];
}

/** The bounds of one call. */
export interface CallBounds {
  /** The task's deadline, in epoch milliseconds. */
  deadlineAt: number;
  signal?: AbortSignal;
}

/** The bounds of one poll. */
export interface PollOptions extends CallBounds {
  /** The last question after the deadline: the status and billing reads are not cut by it. */
  finalAsk?: boolean;
}

/** One `task_upstream_steps` row written before the provider layer (design 3.4, X3). */
export interface LegacyStep {
  position: number;
  kind: Exclude<StepKind, "describe">;
  endpoint: string;
  itemIndex: number | null;
  status: "pending" | "submitted" | "done" | "failed";
  predictionId: string | null;
  output: Record<string, unknown>;
  inlineCostUsd: number;
}

/** What a task in flight at deploy left behind. */
export interface LegacyRows {
  providerTaskId?: string | null;
  steps?: LegacyStep[];
}

/** Media runs as tickets (design 3.4). */
export interface MediaRunner {
  plan(model: string, input: MediaInput, route: Route, options: PlanOptions): Promise<MediaAnswer>;
  send(ticket: MediaTicket, bounds: CallBounds): Promise<MediaAnswer>;
  poll(ticket: MediaTicket, options: PollOptions): Promise<MediaAnswer>;
  recover(ticket: MediaTicket, bounds: CallBounds): Promise<MediaAnswer>;
  ticketFromLegacy(model: string, input: MediaInput, route: Route, options: PlanOptions, legacy: LegacyRows): Promise<MediaAnswer>;
}

/** Limits on the media provider reads itself. */
export interface MediaRunnerOptions {
  mediaLimits: { maxMediaBytes: number };
  /** How long after a running answer to ask again; 0 when the caller paces polls itself. */
  pollIntervalMs?: number;
}

/** What one step answered, for the steps after it and for billing. */
interface StepOutput {
  /** The source param an upload or vocal id replaces, and that id. */
  param?: string;
  id?: string;
  voiceId?: string;
  /** An element's place in its pool, and its id. */
  index?: number;
  elementId?: string;
  urls?: string[];
  /** One url, as steps stored it before lists. */
  url?: string;
  /** Whether the id came from the caller's clone cache. */
  cached?: boolean;
  /** The prediction to bill. */
  prediction?: string;
  /** An element's description, as legacy rows stored it. */
  description?: string;
  error?: string;
}

/** One upstream call of a run. */
interface Step {
  kind: StepKind;
  endpoint: string;
  /** The param the step serves. */
  param?: string;
  itemIndex: number | null;
  status: "pending" | "submitted" | "done";
  predictionId?: string;
  output?: StepOutput;
  /** For an element step: what its describe step wrote. */
  description?: string;
}

/** A ticket as provider reads it. */
interface Ticket {
  version: number;
  model: string;
  route: Route;
  phase: "send" | "running";
  input: MediaInput;
  idempotencyKey: string;
  sourceKeys: Record<string, string>;
  clones: MediaClone[];
  upstream: string;
  /** Upstreams the run may move to before a step is accepted, in order. */
  next: string[];
  /** Why the upstreams before this one could not take the run. */
  reasons: UnavailableReason[];
  /** Whether a step was accepted, which fixes the upstream. */
  accepted: boolean;
  steps: Step[];
  /** Costs known outside billing: descriptions, inline costs of legacy steps. */
  costs: Cost[];
}

/** What a done step of each kind reads off its outputs. */
const UPLOAD_PURPOSE: Readonly<Partial<Record<StepKind, string>>> = { upload_reference: "reference", upload_melody: "melody" };
/** Kling caps an element's description at 100 characters. */
const ELEMENT_DESCRIPTION_MAX = 100;

/**
 * Whether a value carries anything to send.
 * @param value - The value.
 * @returns False for null, undefined, an empty string or an empty list.
 */
function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * The common part of an answer.
 * @param extra - Clones and warnings to carry.
 * @returns The fields every answer has.
 */
function common(extra: Partial<AnswerCommon> = {}): AnswerCommon {
  return { clones: extra.clones ?? [], retiredClones: extra.retiredClones ?? [], warnings: extra.warnings ?? [] };
}

/**
 * The failure class of a media submit's error.
 * @param error - What the submit threw.
 * @returns Its class, or null for anything else.
 */
function classify(error: unknown): Failure | null {
  if (error instanceof NotSent) return { kind: "not_sent" };
  if (error instanceof NoAnswer) return { kind: "no_answer" };
  if (error instanceof Aborted) return { kind: "aborted" };
  if (error instanceof HttpStatus) return modelNotFound(error) ? { kind: "model_not_found" } : { kind: "http_status", status: error.status };
  return null;
}

/**
 * A step's first structured output field.
 * @param outputs - The prediction's outputs.
 * @param field - The field.
 * @returns Its value.
 * @throws {Error} When the output carries no such string.
 */
function outputField(outputs: readonly unknown[], field: string): string {
  const first = outputs[0];
  const value = typeof first === "object" && first !== null ? (first as Record<string, unknown>)[field] : undefined;
  if (typeof value !== "string" || value === "") throw new Error(`No ${field} in the upstream answer`);
  return value;
}

/**
 * Every output as a url.
 * @param outputs - The prediction's outputs.
 * @returns The urls.
 * @throws {Error} When there is none, or one is not a url.
 */
function outputUrls(outputs: readonly unknown[]): string[] {
  if (outputs.length === 0 || !outputs.every((u): u is string => typeof u === "string" && u !== "")) {
    throw new Error("The upstream answered no output url");
  }
  return [...outputs];
}

/**
 * Build the media runner for one provider instance.
 * @param provider - The instance.
 * @param options - Limits on the media it reads.
 * @returns The runner.
 * @throws {ProviderConfigError} When the instance's configuration is invalid.
 */
export function createMediaRunner(provider: Provider, options: MediaRunnerOptions): MediaRunner {
  const config: ProviderConfig = parseProviderConfig(provider.options.config);
  const { keyOf } = provider.options;
  const inFlight = new Map<string, { count: number; waiting: (() => void)[] }>();

  /**
   * Run one request inside the upstream's concurrency cap.
   * @param upstream - The upstream.
   * @param work - The request.
   * @returns What the request answered.
   */
  const capped = async <T>(upstream: string, work: () => Promise<T>): Promise<T> => {
    const cap = config.upstreams[upstream]?.concurrency;
    if (cap === undefined) return work();
    const slot = inFlight.get(upstream) ?? { count: 0, waiting: [] };
    inFlight.set(upstream, slot);
    while (slot.count >= cap) await new Promise<void>((resolve) => slot.waiting.push(resolve));
    slot.count++;
    try {
      return await work();
    } finally {
      slot.count--;
      slot.waiting.shift()?.();
    }
  };

  /**
   * How a call reaches an upstream.
   * @param upstream - The upstream.
   * @returns Its declaration and key.
   */
  const reach = (upstream: string): Reach => ({ name: upstream, decl: config.upstreams[upstream]!, key: keyOf(config.upstreams[upstream]!.key_env) ?? "" });

  /**
   * A model's binding to one upstream.
   * @param ticket - The ticket.
   * @param upstream - The upstream; the ticket's own when omitted.
   * @returns The binding.
   * @throws {Error} When the model is not bound there.
   */
  const bindingOf = (ticket: Pick<Ticket, "model" | "upstream">, upstream = ticket.upstream): MediaBinding => {
    const binding = config.models[ticket.model]?.find((b) => b.upstream === upstream);
    if (binding === undefined) throw new Error(`${ticket.model} is not bound to ${upstream}`);
    return binding;
  };

  /**
   * The sha256 key a source is cached under.
   * @param ticket - The ticket.
   * @param url - The source.
   * @returns The key, or undefined when the source is not an asset the caller knows.
   */
  const shaOf = (ticket: Ticket, url: unknown): string | undefined => (typeof url === "string" ? ticket.sourceKeys[url] : undefined);

  /**
   * The cache key of the clone a step makes, and its kind.
   * @param ticket - The ticket.
   * @param step - The step.
   * @returns The kind and key, or undefined for a step that makes no clone or a source without a key.
   */
  const cloneKeyOf = (ticket: Ticket, step: Step): { kind: MediaClone["kind"]; sourceKey: string } | undefined => {
    const params = ticket.input.params;
    if (step.kind === "vocal") {
      const sha = shaOf(ticket, params[step.param ?? ""]);
      return sha === undefined ? undefined : { kind: "vocal", sourceKey: sha };
    }
    if (step.kind === "voice") {
      const sha = shaOf(ticket, params[bindingOf(ticket).reused_by ?? ""]);
      return sha === undefined ? undefined : { kind: "voice", sourceKey: sha };
    }
    if (step.kind === "element") {
      const list = params[step.param ?? ""];
      const sha = shaOf(ticket, Array.isArray(list) ? list[step.itemIndex ?? 0] : undefined);
      return sha === undefined ? undefined : { kind: "element", sourceKey: `${sha}:Element ${(step.itemIndex ?? 0) + 1}` };
    }
    return undefined;
  };

  /**
   * The output a step has when the caller's cache already holds its clone.
   * @param ticket - The ticket.
   * @param step - The step.
   * @returns The cached output, or undefined.
   */
  const cachedOutput = (ticket: Ticket, step: Step): StepOutput | undefined => {
    const key = cloneKeyOf(ticket, step);
    const hit = key === undefined
      ? undefined
      : ticket.clones.find((c) => c.upstream === ticket.upstream && c.kind === key.kind && c.sourceKey === key.sourceKey);
    if (hit === undefined) return undefined;
    if (step.kind === "voice") return { voiceId: hit.upstreamId, cached: true };
    if (step.kind === "element") return { index: step.itemIndex ?? 0, elementId: hit.upstreamId, cached: true };
    return { param: step.param, id: hit.upstreamId, cached: true };
  };

  /**
   * The steps of a run on the ticket's upstream (design 6.2).
   * @param ticket - The ticket, its steps not yet set.
   * @returns The steps in order: extra steps before, the model's own call, extra steps after.
   */
  const planSteps = (ticket: Ticket): Step[] => {
    const binding = bindingOf(ticket);
    const steps: Step[] = [];
    /**
     * Add one step, done already when the cache holds its clone.
     * @param step - The step.
     * @param describe - Whether a description is written first.
     */
    const add = (step: Step, describe: boolean): void => {
      const cached = cachedOutput(ticket, step);
      if (cached !== undefined) {
        steps.push({ ...step, status: "done", output: cached });
        return;
      }
      if (describe) steps.push({ kind: "describe", endpoint: "", param: step.param, itemIndex: step.itemIndex, status: "pending" });
      steps.push(step);
    };
    for (const at of ["before", "own", "after"] as const) {
      if (at === "own") {
        add({ kind: binding.reused_by === undefined ? "generate" : "voice", endpoint: binding.model_id, itemIndex: null, status: "pending" }, false);
        continue;
      }
      for (const extra of (binding.extra_steps ?? []).filter((s) => s.at === at)) {
        const base = { kind: extra.kind, endpoint: extra.endpoint, ...(extra.for_param === undefined ? {} : { param: extra.for_param }), status: "pending" as const };
        const value = extra.for_param === undefined ? undefined : ticket.input.params[extra.for_param];
        if (extra.for_param !== undefined && !isPresent(value)) continue;
        const items = extra.per_item === true && Array.isArray(value) ? value.map((_, i) => i) : [null];
        for (const itemIndex of items) add({ ...base, itemIndex }, extra.kind === "element" && extra.describe !== undefined);
      }
    }
    return steps;
  };

  /**
   * What the done steps answered, for the steps after them.
   * @param ticket - The ticket.
   * @returns Ids by param, element ids, the voice, the output urls, the predictions to bill and the cached ids used.
   */
  const carried = (ticket: Ticket): { ids: Record<string, string>; elementIds: string[]; voiceId?: string; urls?: string[]; predictions: string[]; cached: { kind: string; id: string }[] } => {
    const out: ReturnType<typeof carried> = { ids: {}, elementIds: [], predictions: [], cached: [] };
    for (const step of ticket.steps) {
      const o = step.output;
      if (step.status !== "done" || o === undefined) continue;
      if (typeof o.prediction === "string" && o.prediction !== "") out.predictions.push(o.prediction);
      if (typeof o.param === "string" && typeof o.id === "string") out.ids[o.param] = o.id;
      if (typeof o.voiceId === "string") out.voiceId = o.voiceId;
      if (typeof o.index === "number" && typeof o.elementId === "string") out.elementIds[o.index] = o.elementId;
      if (Array.isArray(o.urls)) out.urls = o.urls;
      else if (typeof o.url === "string") out.urls = [o.url];
      if (o.cached === true) out.cached.push({ kind: step.kind, id: (o.id ?? o.voiceId ?? o.elementId)! });
    }
    return out;
  };

  /**
   * The url a step reads from its param.
   * @param ticket - The ticket.
   * @param step - The step.
   * @returns The url.
   * @throws {Error} When the param carries none.
   */
  const sourceOf = (ticket: Ticket, step: Step): string => {
    const value = ticket.input.params[step.param ?? ""];
    const url = step.itemIndex === null ? value : Array.isArray(value) ? value[step.itemIndex] : undefined;
    if (typeof url !== "string" || url === "") throw new Error(`The ${step.kind} step needs a source in '${step.param ?? ""}'`);
    return url;
  };

  /**
   * The voice id a clone step registers: a letter first, letters and digits, unique per run.
   * @param ticket - The ticket.
   * @returns The id.
   */
  const customVoiceId = (ticket: Ticket): string => `Breatic${ticket.idempotencyKey.replace(/[^A-Za-z0-9]/g, "")}`;

  /**
   * The body one step submits.
   * @param ticket - The ticket.
   * @param step - The step.
   * @returns The body.
   * @throws {Error} When the step lacks what it needs.
   */
  const bodyOf = (ticket: Ticket, step: Step): Record<string, unknown> => {
    const binding = bindingOf(ticket);
    const done = carried(ticket);
    switch (step.kind) {
      case "upload_reference":
      case "upload_melody":
        return { audio: sourceOf(ticket, step), purpose: UPLOAD_PURPOSE[step.kind] };
      case "vocal":
        return { audio: sourceOf(ticket, step) };
      case "voice":
        return { ...buildBody(binding, { params: ticket.input.params, prompt: "" }), custom_voice_id: customVoiceId(ticket) };
      case "speak":
        if (done.voiceId === undefined) throw new Error("No cloned voice to speak with");
        return { text: ticket.input.prompt, voice_id: done.voiceId };
      case "element": {
        const image = sourceOf(ticket, step);
        return { name: `Element ${(step.itemIndex ?? 0) + 1}`, description: step.description ?? "", image, element_refer_list: [image] };
      }
      default: {
        const params: Record<string, unknown> = { ...ticket.input.params, ...done.ids };
        const elementParam = binding.extra_steps?.find((s) => s.kind === "element")?.for_param;
        if (elementParam !== undefined && done.elementIds.length > 0) params[elementParam] = done.elementIds.map((id) => ({ element_id: id }));
        return buildBody(binding, { params, prompt: ticket.input.prompt });
      }
    }
  };

  /**
   * What a finished step answered, in the shape later steps read.
   * @param ticket - The ticket.
   * @param step - The step.
   * @param outputs - The prediction's outputs.
   * @param prediction - The prediction id, when there is one.
   * @returns The output.
   * @throws {Error} When the outputs lack what the step makes.
   */
  const outputOf = (ticket: Ticket, step: Step, outputs: readonly unknown[], prediction: string | undefined): StepOutput => {
    const billedAs = prediction === undefined ? {} : { prediction };
    switch (step.kind) {
      case "upload_reference":
      case "upload_melody":
        return { param: step.param, id: outputField(outputs, `${UPLOAD_PURPOSE[step.kind]!}_id`), ...billedAs };
      case "vocal":
        return { param: step.param, id: outputField(outputs, "vocal_id"), ...billedAs };
      case "voice":
        return { voiceId: customVoiceId(ticket), ...billedAs };
      case "element":
        return { index: step.itemIndex ?? 0, elementId: outputField(outputs, "element_id"), ...billedAs };
      case "speak":
        return { urls: [outputUrls(outputs)[0]!], ...billedAs };
      default:
        return { urls: outputUrls(outputs), ...billedAs };
    }
  };

  /**
   * The clone a finished step made, for the caller's cache.
   * @param ticket - The ticket.
   * @param step - The step, done.
   * @returns The clone, or none.
   */
  const madeClones = (ticket: Ticket, step: Step): MediaClone[] => {
    const key = cloneKeyOf(ticket, step);
    const id = step.output?.id ?? step.output?.voiceId ?? step.output?.elementId;
    return key === undefined || id === undefined || step.output?.cached === true ? [] : [{ upstream: ticket.upstream, ...key, upstreamId: id }];
  };

  /**
   * The next ticket, with a newer version.
   * @param ticket - The ticket.
   * @param change - What changes.
   * @returns The new ticket.
   */
  const next = (ticket: Ticket, change: Partial<Ticket>): Ticket => ({ ...ticket, ...change, version: ticket.version + 1 });

  /**
   * The first step not done.
   * @param ticket - The ticket.
   * @returns The step and its index, or undefined when every step is done.
   */
  const current = (ticket: Ticket): { step: Step; index: number } | undefined => {
    const index = ticket.steps.findIndex((s) => s.status !== "done");
    return index < 0 ? undefined : { step: ticket.steps[index]!, index };
  };

  /**
   * The answer for a ticket whose next step waits to be sent or asked about.
   * @param ticket - The ticket.
   * @param extra - Clones and warnings to carry.
   * @returns A send or running answer.
   */
  const waiting = (ticket: Ticket, extra: Partial<AnswerCommon> = {}): MediaAnswer => {
    const at = current(ticket);
    if (at === undefined || at.step.status === "submitted") {
      return { state: "running", ticket: { ...ticket, phase: "running" } as unknown as MediaTicket, askAgainAt: Date.now() + (options.pollIntervalMs ?? 0), ...common(extra) };
    }
    return { state: "send", ticket: { ...ticket, phase: "send" } as unknown as MediaTicket, step: { kind: at.step.kind }, ...common(extra) };
  };

  /**
   * A failed answer, retiring the cached clones the upstream said are gone.
   * @param ticket - The ticket.
   * @param reason - Why.
   * @param warnings - Anything to log.
   * @returns The answer.
   */
  const failed = (ticket: Ticket, reason: Error, warnings: MediaWarning[] = []): MediaAnswer => {
    const retired = reason instanceof UpstreamTaskFailed
      ? carried(ticket).cached.flatMap(({ kind, id }) => {
        if (!gone(kind, reason.upstreamError, id)) return [];
        return ticket.clones.filter((c) => c.upstream === ticket.upstream && c.kind === kind && c.upstreamId === id);
      })
      : [];
    const notes = retired.map((c) => ({ code: "upstream_clone_retired", detail: { upstream: c.upstream, kind: c.kind, upstreamId: c.upstreamId } }));
    return { state: "failed", reason, costs: ticket.costs, ...common({ retiredClones: retired, warnings: [...warnings, ...notes] }) };
  };

  /**
   * Finish a run whose steps are all done: its outputs and what each prediction cost.
   * @param ticket - The ticket.
   * @param bounds - The bounds billing is asked under.
   * @param extra - Clones and warnings to carry.
   * @returns The done answer, or failed when the run produced no output.
   */
  const finish = async (ticket: Ticket, bounds: RequestBounds, extra: Partial<AnswerCommon>): Promise<MediaAnswer> => {
    const done = carried(ticket);
    if (done.urls === undefined || done.urls.length === 0) return failed(ticket, new Error("The run produced no output"), extra.warnings);
    const costs = [...ticket.costs];
    const warnings = [...(extra.warnings ?? [])];
    const up = reach(ticket.upstream);
    for (const prediction of done.predictions) {
      const read = await capped(ticket.upstream, () => billed(up, prediction, bounds, false));
      costs.push(read.cost);
      warnings.push(...read.warnings);
    }
    return { state: "done", outputs: done.urls.map((url) => ({ kind: "url", url })), costs, servedBy: ticket.upstream, ...common({ ...extra, warnings }) };
  };

  /**
   * Mark a step done and move on: hand the next step back, or finish.
   * @param ticket - The ticket.
   * @param index - The step's place.
   * @param output - What it answered.
   * @param bounds - The bounds a finish bills under.
   * @param warnings - Anything to log.
   * @returns The next answer.
   */
  const completed = async (ticket: Ticket, index: number, output: StepOutput, bounds: RequestBounds, warnings: MediaWarning[]): Promise<MediaAnswer> => {
    const steps = ticket.steps.map((s, i) => (i === index ? { ...s, status: "done" as const, output } : s));
    const moved = next(ticket, { steps });
    const clones = madeClones(moved, steps[index]!);
    return current(moved) === undefined ? finish(moved, bounds, { clones, warnings }) : waiting(moved, { clones, warnings });
  };

  /**
   * A new ticket on an upstream, its steps planned.
   * @param base - Everything but the steps.
   * @returns The ticket.
   */
  const planned = (base: Omit<Ticket, "steps">): Ticket => {
    const ticket = { ...base, steps: [] as Step[] };
    ticket.steps = planSteps(ticket);
    return ticket;
  };

  /**
   * Order a model's upstreams for a run.
   * @param model - The model.
   * @param input - The run.
   * @param route - The caller's mode.
   * @returns The plan.
   * @throws {NoUpstreamAvailable} When no upstream is configured.
   * @throws {UpstreamRequestRejected} When the route names an upstream the model is not bound to.
   */
  const route = async (model: string, input: MediaInput, route: Route): Promise<RoutePlan> => {
    let candidates = candidatesOf(config, model, keyOf);
    if (route.mode === "cheapest") {
      const estimates = await orderByPrice(provider.pricingRules(model), provider.availability(model), {
        params: input.params,
        prompt: input.prompt,
        durations: {},
        placeholders: [],
        durationsMissing: [],
      });
      candidates = candidates.map((c) => ({ ...c, estimateUsd: estimates.find((e) => e.upstream === c.upstream)?.costUsd }));
    }
    return planRoute(model, route, candidates);
  };

  /**
   * The first ticket of a run, or the failed answer when no upstream can take it.
   * @param model - The model.
   * @param input - The run.
   * @param chosen - The caller's mode.
   * @param planOptions - Keys and clones.
   * @param pick - Picks the upstream from the ordered candidates.
   * @returns The ticket, or the answer.
   * @throws {UpstreamRequestRejected} When the route names an upstream the model is not bound to.
   */
  const open = async (
    model: string,
    input: MediaInput,
    chosen: Route,
    planOptions: PlanOptions,
    pick: (order: Candidate[]) => Candidate,
  ): Promise<Omit<Ticket, "steps"> | MediaAnswer> => {
    let plan: RoutePlan;
    try {
      plan = await route(model, input, chosen);
    } catch (error) {
      if (error instanceof NoUpstreamAvailable) return { state: "failed", reason: error, costs: [], ...common() };
      throw error;
    }
    const order = plan.order;
    const first = pick(order);
    return {
      version: 1,
      model,
      route: chosen,
      phase: "send",
      input,
      idempotencyKey: planOptions.idempotencyKey,
      sourceKeys: planOptions.sourceKeys,
      clones: planOptions.clones,
      upstream: first.upstream,
      next: order.filter((c) => c !== first).map((c) => c.upstream),
      reasons: plan.skipped,
      accepted: false,
      costs: [],
    };
  };

  /**
   * Read the caller's ticket.
   * @param raw - The ticket as stored.
   * @param phase - The phase it must be in.
   * @returns The ticket.
   * @throws {Error} When it is in another phase.
   */
  const read = (raw: MediaTicket, phase: Ticket["phase"]): Ticket => {
    const ticket = raw as unknown as Ticket;
    if (ticket.phase !== phase) throw new Error(`The ticket is ${String(ticket.phase)}, not ${phase}`);
    return ticket;
  };

  /**
   * Write the element description: read the image and ask the understand model.
   * @param ticket - The ticket.
   * @param index - The describe step's place; the element step follows it.
   * @param bounds - The deadline and signal.
   * @returns The send answer for the element step, or failed when the image is refused.
   */
  const describe = async (ticket: Ticket, index: number, bounds: CallBounds): Promise<MediaAnswer> => {
    const step = ticket.steps[index]!;
    const spec = bindingOf(ticket).extra_steps?.find((s) => s.kind === "element")?.describe;
    if (spec === undefined) throw new Error(`${ticket.model} has no description step on ${ticket.upstream}`);
    let media;
    try {
      media = await fetchMedia({ url: sourceOf(ticket, step), maxBytes: options.mediaLimits.maxMediaBytes, deadlineAt: bounds.deadlineAt, ...(bounds.signal ? { signal: bounds.signal } : {}) });
    } catch (error) {
      if (error instanceof MediaRefused) return failed(ticket, error);
      throw error;
    }
    const answer = await provider.llm.understand({
      model: spec.model,
      question: spec.question,
      media: [media],
      maxOutputTokens: spec.max_output_tokens,
      deadlineAt: bounds.deadlineAt,
      ...(bounds.signal ? { signal: bounds.signal } : {}),
    });
    const description = answer.text.trim().slice(0, ELEMENT_DESCRIPTION_MAX);
    const steps = ticket.steps.map((s, i) => {
      if (i === index) return { ...s, status: "done" as const, output: {} };
      return i === index + 1 ? { ...s, description } : s;
    });
    return waiting(next(ticket, { steps, costs: [...ticket.costs, answer.cost] }));
  };

  return {
    async plan(model, input, chosen, planOptions) {
      const opened = await open(model, input, chosen, planOptions, (order) => order[0]!);
      return "state" in opened ? opened : waiting(planned(opened));
    },

    async send(raw, bounds) {
      const ticket = read(raw, "send");
      if (Date.now() >= bounds.deadlineAt) throw new DeadlinePassed(bounds.deadlineAt);
      const at = current(ticket);
      if (at === undefined) throw new Error("The ticket has no step to send");
      if (at.step.kind === "describe") return describe(ticket, at.index, bounds);
      const body = bodyOf(ticket, at.step);
      const requestBounds = { deadlineAt: bounds.deadlineAt, ...(bounds.signal ? { signal: bounds.signal } : {}) };
      let answer;
      try {
        answer = await capped(ticket.upstream, () => submit(reach(ticket.upstream), at.step.endpoint, body, requestBounds));
      } catch (error) {
        const failure = classify(error);
        if (failure === null || failure.kind === "no_answer") throw error;
        if (failure.kind === "aborted") throw Date.now() >= bounds.deadlineAt ? new DeadlinePassed(bounds.deadlineAt) : error;
        if (decide(failure, "media_submit", 0, 0) === "stop") {
          return failed(ticket, new UpstreamRequestRejected(ticket.model, ticket.upstream, (error as Error).message + (error instanceof HttpStatus ? `: ${error.bodySnippet}` : "")));
        }
        const reasons: UnavailableReason[] = [...(ticket.reasons ?? []), { upstream: ticket.upstream, kind: "failed", failure: failure.kind }];
        const [to, ...rest] = ticket.next;
        if (ticket.accepted || ticket.route.mode === "upstream" || to === undefined) {
          // The upstream lacking the model is a lasting answer: retrying the same ticket would get it again.
          if (failure.kind === "model_not_found") return failed(ticket, new NoUpstreamAvailable(ticket.model, reasons));
          throw new SendNotAccepted(ticket.upstream, error);
        }
        const moved = planned({ ...ticket, version: ticket.version + 1, upstream: to, next: rest, reasons, costs: [] });
        return waiting(moved, { warnings: [{ code: "upstream_switched", detail: { model: ticket.model, from: ticket.upstream, to, failure: failure.kind } }] });
      }
      if (answer.outputs !== undefined) {
        let output: StepOutput;
        try {
          output = outputOf(ticket, at.step, answer.outputs, answer.predictionId);
        } catch (error) {
          return failed(ticket, error as Error);
        }
        return completed({ ...ticket, accepted: true }, at.index, output, requestBounds, []);
      }
      const steps = ticket.steps.map((s, i) => (i === at.index ? { ...s, status: "submitted" as const, predictionId: answer.predictionId! } : s));
      return waiting(next(ticket, { steps, accepted: true }));
    },

    async poll(raw, pollOptions) {
      const ticket = read(raw, "running");
      const bounds: RequestBounds = {
        ...(pollOptions.finalAsk === true ? {} : { deadlineAt: pollOptions.deadlineAt }),
        ...(pollOptions.signal ? { signal: pollOptions.signal } : {}),
      };
      if (pollOptions.finalAsk !== true && Date.now() >= pollOptions.deadlineAt) throw new DeadlinePassed(pollOptions.deadlineAt);
      const at = current(ticket);
      if (at === undefined) return finish(ticket, bounds, {});
      let asked;
      try {
        asked = await capped(ticket.upstream, () => ask(reach(ticket.upstream), at.step.predictionId!, bounds));
      } catch (error) {
        const resendable = error instanceof NoAnswer || error instanceof NotSent
          || (error instanceof HttpStatus && (error.status === 429 || error.status >= 500));
        if (error instanceof Aborted && pollOptions.finalAsk !== true && Date.now() >= pollOptions.deadlineAt) throw new DeadlinePassed(pollOptions.deadlineAt);
        if (!resendable) throw error;
        return waiting(ticket, { warnings: [{ code: "poll_request_failed", detail: { upstream: ticket.upstream, predictionId: at.step.predictionId, error: String(error) } }] });
      }
      if (asked.state === "running") return waiting(ticket);
      if (asked.state === "failed") return failed(ticket, new UpstreamTaskFailed(ticket.upstream, asked.error));
      let output: StepOutput;
      try {
        output = outputOf(ticket, at.step, asked.outputs, at.step.predictionId);
      } catch (error) {
        return failed(ticket, error as Error);
      }
      return completed(ticket, at.index, output, bounds, []);
    },

    async recover(raw) {
      const ticket = read(raw, "send");
      const at = current(ticket);
      return waiting(ticket, { warnings: [{ code: "potential_duplicate_cost", detail: { model: ticket.model, upstream: ticket.upstream, step: at?.step.kind } }] });
    },

    async ticketFromLegacy(model, input, chosen, planOptions, legacy) {
      if (!isPresent(legacy.providerTaskId) && (legacy.steps ?? []).length === 0) return this.plan(model, input, chosen, planOptions);
      // Runs before the provider layer all ran on WaveSpeed.
      const opened = await open(model, input, chosen, planOptions, (order) => order.find((c) => config.upstreams[c.upstream]?.kind === "wavespeed") ?? order[0]!);
      if ("state" in opened) return opened;
      const base = { ...opened, next: [], accepted: true };
      const binding = bindingOf(base);
      if (isPresent(legacy.providerTaskId)) {
        const steps: Step[] = [{ kind: "generate", endpoint: binding.model_id, itemIndex: null, status: "submitted", predictionId: legacy.providerTaskId! }];
        return waiting({ ...base, steps }, { warnings: [{ code: "async_resume_stored_provider_task", detail: { model, providerTaskId: legacy.providerTaskId } }] });
      }
      const steps: Step[] = [];
      const costs: Cost[] = [];
      for (const row of [...legacy.steps!].sort((a, b) => a.position - b.position)) {
        const param = binding.extra_steps?.find((s) => s.kind === row.kind && s.endpoint === row.endpoint)?.for_param;
        const output = row.output as StepOutput;
        if (row.status === "failed") {
          return failed({ ...base, steps, costs }, new UpstreamTaskFailed(opened.upstream, typeof output.error === "string" ? output.error : `step ${row.kind} failed`));
        }
        if (row.inlineCostUsd > 0) costs.push({ state: "known", usd: row.inlineCostUsd, source: "reported" });
        const step: Step = {
          kind: row.kind,
          endpoint: row.endpoint,
          ...(param === undefined ? {} : { param }),
          itemIndex: row.itemIndex,
          status: row.status,
          ...(row.predictionId === null ? {} : { predictionId: row.predictionId }),
          ...(row.status === "done" ? { output } : {}),
          ...(typeof output.description === "string" ? { description: output.description } : {}),
        };
        const describes = row.kind === "element" && row.status === "pending" && step.description === undefined
          && binding.extra_steps?.find((s) => s.kind === "element")?.describe !== undefined;
        if (describes) steps.push({ kind: "describe", endpoint: "", ...(param === undefined ? {} : { param }), itemIndex: row.itemIndex, status: "pending" });
        steps.push(step);
      }
      return waiting({ ...base, steps, costs });
    },
  };
}
