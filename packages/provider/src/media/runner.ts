// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { candidateOf, candidatesOf, type MediaBinding } from "@provider/config/schema.js";
import type { Cost } from "@provider/cost.js";
import { DeadlinePassed, NoUpstreamAvailable, SendNotAccepted, UpstreamRequestRejected, UpstreamTaskFailed, type UnavailableReason } from "@provider/errors.js";
import { Aborted, HttpStatus, NoAnswer, NotSent } from "@provider/http/errors.js";
import { fetchMedia, MediaRefused } from "@provider/http/fetch-media.js";
import { boundSignal, sideBounds } from "@provider/http/request.js";
import { outputUrls, type MediaAdapter, type Reach, type RequestBounds, type StepCodec, type StepContext, type StepOutput } from "@provider/media/adapter.js";
import { adapterOf } from "@provider/media/adapters.js";
import { buildBody } from "@provider/media/body.js";
import { assess, cloneKeyOf, heldClone, isPresent, stepCalls, stepSource, type CloneKind, type HeldClone } from "@provider/pricing/estimate.js";
import type { Provider } from "@provider/provider.js";
import { decide, passingStatus, type Failure } from "@provider/routing/decide.js";
import { planRoute, type Candidate, type Route, type RoutePlan } from "@provider/routing/route.js";
import { failedReason } from "@provider/routing/try-in-order.js";

/**
 * Everything provider knows about one media run. The caller stores it as JSON
 * and hands it back; only `version` is the caller's to read, for a
 * compare-and-set write.
 */
export interface MediaTicket {
  readonly version: number;
  readonly [key: string]: unknown;
}

/** What one step of a run does. */
export type StepKind = "generate" | "upload_reference" | "upload_melody" | "vocal" | "voice" | "speak" | "element" | "describe";

/** One output of a finished run. */
export type MediaOutput =
  | { kind: "url"; url: string; contentType?: string }
  | { kind: "bytes"; bytes: Uint8Array; contentType: string };

/** One cached clone, as the caller stores it. */
export interface MediaClone extends HeldClone {
  upstreamId: string;
}

/** Something provider wants the caller to log. */
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

/** Where a run is after one call. */
export type MediaAnswer = AnswerCommon &
  (
    | { state: "send"; ticket: MediaTicket; step: { kind: StepKind } }
    | { state: "running"; ticket: MediaTicket; askAgainAt: number }
    | { state: "done"; outputs: MediaOutput[]; costs: Cost[]; servedBy: string }
    /** Why: no upstream could take the run, one refused it, its task failed, a source was refused, or another error. */
    | { state: "failed"; reason: NoUpstreamAvailable | UpstreamRequestRejected | UpstreamTaskFailed | MediaRefused | Error; costs: Cost[] }
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
  /**
   * Clip lengths in seconds of the sources whose lengths are known, by our param name. Every mode reads them: each
   * upstream's input limits (`rejects`) and its price, which decide whether it can take the run and, in cheapest mode,
   * the order. Pass every source whose length is known; a source left out passes every length limit, and an upstream
   * that bills by its length ranks after every upstream with a known price.
   */
  durations: Record<string, number[]>;
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

/** One `task_upstream_steps` row written before the provider layer. */
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

/** Media runs as tickets. */
export interface MediaRunner {
  plan(model: string, input: MediaInput, route: Route, options: PlanOptions): Promise<MediaAnswer>;
  send(ticket: MediaTicket, bounds: CallBounds): Promise<MediaAnswer>;
  poll(ticket: MediaTicket, options: PollOptions): Promise<MediaAnswer>;
  recover(ticket: MediaTicket, bounds: CallBounds): Promise<MediaAnswer>;
  ticketFromLegacy(model: string, input: MediaInput, route: Route, options: PlanOptions, legacy: LegacyRows): Promise<MediaAnswer>;
  /**
   * What a ticket cost when its task ends on a throw: the costs it holds and a billing lookup
   * for every prediction an upstream accepted. Sends nothing; called once, by the caller.
   */
  abandon(ticket: MediaTicket): { costs: Cost[] };
}

/** Limits on the media provider reads itself. */
export interface MediaRunnerOptions {
  mediaLimits: { maxMediaBytes: number };
  /** How long after a running answer to ask again; 0 when the caller paces polls itself. */
  pollIntervalMs: number;
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
  /** What the adapter needs to ask about the prediction again. */
  handle?: Record<string, string>;
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

/** The image types the understand models read (shared's understand/media-formats.ts IMAGE_TYPES). */
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** Kling caps an element's description at 100 characters. */
const ELEMENT_DESCRIPTION_MAX = 100;

/**
 * One output as the caller takes it: a data URI as its bytes, any other url as it is.
 * @param url - The output url.
 * @returns The output.
 */
function mediaOutputOf(url: string): MediaOutput {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) return { kind: "url", url };
  const [type = "", ...flags] = url.slice("data:".length, comma).split(";");
  const data = url.slice(comma + 1);
  const bytes = new Uint8Array(flags.includes("base64")
    ? Buffer.from(data, "base64")
    // Each %XX is one byte, read as Latin-1 so no byte is turned into UTF-8; a stray "%" stays as it is.
    : Buffer.from(data.replace(/%([0-9a-fA-F]{2})/g, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1"));
  return { kind: "bytes", bytes, contentType: type === "" ? "text/plain" : type };
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
 * Whether an upstream's failure is a lasting answer: it lacks the model or the balance, so retrying the same ticket would get it again.
 * @param failure - The failure's kind.
 * @returns True for a lasting answer.
 */
function lasting(failure: string): boolean {
  return failure === "model_not_found" || failure === "insufficient_balance";
}

/**
 * The failure class of a media submit's error.
 * @param error - What the submit threw.
 * @param adapter - The upstream's adapter, which reads its refusals.
 * @returns Its class, or null for anything else.
 */
function classify(error: unknown, adapter: MediaAdapter): Failure | null {
  if (error instanceof NotSent) return { kind: "not_sent" };
  if (error instanceof NoAnswer) return { kind: "no_answer" };
  if (error instanceof Aborted) return { kind: "aborted" };
  if (error instanceof HttpStatus) {
    const refusal = adapter.refusal(error);
    return refusal === undefined ? { kind: "http_status", status: error.status } : { kind: refusal };
  }
  return null;
}

/**
 * Whether an abort of a call bounded by these came from its deadline: the deadline has
 * passed, or the caller's own signal did not fire (a timer may fire a millisecond before
 * the clock reaches the deadline).
 * @param bounds - The call's deadline and signal.
 * @returns True when the deadline cut the call.
 */
function cutAtDeadline(bounds: CallBounds): boolean {
  return Date.now() >= bounds.deadlineAt || bounds.signal?.aborted !== true;
}

/**
 * Whether an error or anything on its cause chain passes a test.
 * @param error - The error.
 * @param test - The test.
 * @returns True when one does.
 */
function inChain(error: unknown, test: (e: Error) => boolean): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (test(current)) return true;
  }
  return false;
}

/**
 * Build the media runner for one provider instance.
 * @param provider - The instance.
 * @param options - Limits on the media it reads.
 * @returns The runner.
 */
export function createMediaRunner(provider: Provider, options: MediaRunnerOptions): MediaRunner {
  const { config, keyOf } = provider;
  const inFlight = new Map<string, { count: number; waiting: (() => void)[] }>();

  /**
   * Wait for a slot of an upstream to be handed over, leaving the queue when the request's bounds end.
   * @param upstream - The upstream.
   * @param slot - Its slot state.
   * @param slot.waiting - The queue of requests waiting for a slot.
   * @param bounds - The request's deadline and signal.
   * @throws {Aborted} When the deadline passed or the signal fired before a slot was free.
   */
  const waitForSlot = async (upstream: string, slot: { waiting: (() => void)[] }, bounds: RequestBounds): Promise<void> => {
    const { signal, dispose } = boundSignal(bounds);
    try {
      await new Promise<void>((resolve, reject) => {
        /**
         * Take the free slot.
         */
        const woken = (): void => {
          signal.removeEventListener("abort", leave);
          resolve();
        };
        /**
         * Leave the queue without a slot.
         */
        const leave = (): void => {
          const at = slot.waiting.indexOf(woken);
          if (at >= 0) slot.waiting.splice(at, 1);
          reject(new Aborted(upstream));
        };
        if (signal.aborted) {
          reject(new Aborted(upstream));
          return;
        }
        slot.waiting.push(woken);
        signal.addEventListener("abort", leave, { once: true });
      });
    } finally {
      dispose();
    }
  };

  /**
   * Run one request inside the upstream's concurrency cap.
   * @param upstream - The upstream.
   * @param bounds - The request's deadline and signal, which also end its wait for a slot.
   * @param work - The request.
   * @returns What the request answered.
   * @throws {Aborted} When the bounds end while it waits for a slot.
   */
  const capped = async <T>(upstream: string, bounds: RequestBounds, work: () => Promise<T>): Promise<T> => {
    const cap = config.upstreams[upstream]?.concurrency;
    if (cap === undefined) return work();
    const slot = inFlight.get(upstream) ?? { count: 0, waiting: [] };
    inFlight.set(upstream, slot);
    // First in, first out: a released slot is handed to the head of the queue, so a
    // request that frees one and asks again at once cannot take it back.
    if (slot.count < cap) slot.count++;
    else await waitForSlot(upstream, slot, bounds);
    try {
      return await work();
    } finally {
      const next = slot.waiting.shift();
      if (next) next();
      else slot.count--;
    }
  };

  /**
   * How a call reaches an upstream.
   * @param upstream - The upstream.
   * @returns Its declaration and key.
   */
  const reach = (upstream: string): Reach => ({ name: upstream, decl: config.upstreams[upstream]!, key: keyOf(config.upstreams[upstream]!.key_env) ?? "" });

  /**
   * The adapter of an upstream.
   * @param upstream - The upstream.
   * @returns Its kind's adapter.
   * @throws {Error} When provider has no adapter for the kind.
   */
  const adapterFor = (upstream: string): MediaAdapter => adapterOf(config.upstreams[upstream]!.kind);

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
   * The cache key of the clone a step makes, and its kind, by the rule every estimate keys clones with.
   * @param ticket - The ticket.
   * @param step - The step.
   * @returns The kind and key, or undefined for a step that makes no clone or a source without a key.
   */
  const stepCloneKey = (ticket: Ticket, step: Step): { kind: CloneKind; sourceKey: string } | undefined =>
    cloneKeyOf(step.kind, step.kind === "voice" ? bindingOf(ticket).reused_by : step.param, ticket.input.params, ticket.sourceKeys, step.itemIndex);

  /**
   * The output a step has when the caller's cache already holds its clone.
   * @param ticket - The ticket.
   * @param step - The step.
   * @returns The cached output, or undefined.
   */
  const cachedOutput = (ticket: Ticket, step: Step): StepOutput | undefined => {
    const hit = heldClone(ticket.clones, ticket.upstream, stepCloneKey(ticket, step));
    if (hit === undefined) return undefined;
    if (step.kind === "voice") return { voiceId: hit.upstreamId, cached: true };
    if (step.kind === "element") return { index: step.itemIndex ?? 0, elementId: hit.upstreamId, cached: true };
    return { param: step.param, id: hit.upstreamId, cached: true };
  };

  /**
   * The steps of a run on the ticket's upstream.
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
        for (const itemIndex of stepCalls(extra, ticket.input.params)) add({ ...base, itemIndex }, extra.kind === "element" && extra.describe !== undefined);
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
    const url = stepSource(ticket.input.params, step.param, step.itemIndex);
    if (url === undefined) throw new Error(`The ${step.kind} step needs a source in '${step.param ?? ""}'`);
    return url;
  };

  /**
   * The voice id a clone step registers: a letter first, letters and digits, unique per run.
   * @param ticket - The ticket.
   * @returns The id.
   */
  const customVoiceId = (ticket: Ticket): string => `Breatic${ticket.idempotencyKey.replace(/[^A-Za-z0-9]/g, "")}`;

  /**
   * What an extra step needs to write its request and read its answer.
   * @param ticket - The ticket.
   * @param step - The step.
   * @returns The context.
   */
  const contextOf = (ticket: Ticket, step: Step): StepContext => ({
    source: () => sourceOf(ticket, step),
    params: ticket.input.params,
    prompt: ticket.input.prompt,
    binding: bindingOf(ticket),
    customVoiceId: customVoiceId(ticket),
    voice: () => {
      const { voiceId } = carried(ticket);
      // The configuration load refuses a speak step that does not follow the binding's own voice call, whose output
      // or cached clone carries the voice id.
      /* v8 ignore next -- @preserve */
      if (voiceId === undefined) throw new Error("No cloned voice to speak with");
      return voiceId;
    },
    description: step.description,
    itemIndex: step.itemIndex,
    param: step.param,
  });

  /**
   * How the ticket's upstream writes and reads an extra step.
   * @param ticket - The ticket.
   * @param kind - The step's kind.
   * @returns The codec.
   * @throws {Error} When the upstream does not speak the kind.
   */
  const codecOf = (ticket: Ticket, kind: StepKind): StepCodec => {
    const codec = kind === "generate" || kind === "describe" ? undefined : adapterFor(ticket.upstream).steps[kind];
    if (codec === undefined) throw new Error(`${ticket.upstream} has no ${kind} step`);
    return codec;
  };

  /**
   * The body one step submits.
   * @param ticket - The ticket.
   * @param step - The step.
   * @returns The body.
   * @throws {Error} When the step lacks what it needs.
   */
  const bodyOf = (ticket: Ticket, step: Step): Record<string, unknown> => {
    if (step.kind !== "generate") return codecOf(ticket, step.kind).body(contextOf(ticket, step));
    const binding = bindingOf(ticket);
    const done = carried(ticket);
    const params: Record<string, unknown> = { ...ticket.input.params, ...done.ids };
    const elementParam = binding.extra_steps?.find((s) => s.kind === "element")?.for_param;
    if (elementParam !== undefined && done.elementIds.length > 0) params[elementParam] = done.elementIds.map((id) => ({ element_id: id }));
    return buildBody(binding, { params, prompt: ticket.input.prompt });
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
    if (step.kind === "generate") return { urls: outputUrls(outputs), ...billedAs };
    return { ...codecOf(ticket, step.kind).output(outputs, contextOf(ticket, step)), ...billedAs };
  };

  /**
   * The clone a finished step made, for the caller's cache.
   * @param ticket - The ticket.
   * @param step - The step, done.
   * @returns The clone, or none.
   */
  const madeClones = (ticket: Ticket, step: Step): MediaClone[] => {
    const key = stepCloneKey(ticket, step);
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
      return { state: "running", ticket: { ...ticket, phase: "running" } as unknown as MediaTicket, askAgainAt: Date.now() + options.pollIntervalMs, ...common(extra) };
    }
    return { state: "send", ticket: { ...ticket, phase: "send" } as unknown as MediaTicket, step: { kind: at.step.kind }, ...common(extra) };
  };

  /**
   * A billing lookup for every prediction an upstream accepted on the ticket: the done steps'
   * and the one sent and not yet done. A lookup reads the net of deductions and refunds.
   * @param ticket - The ticket.
   * @returns One pending cost per prediction.
   */
  const acceptedLookups = (ticket: Ticket): Cost[] =>
    ticket.steps.flatMap((step) => {
      const prediction = step.status === "done" ? step.output?.prediction : step.predictionId;
      return typeof prediction === "string" && prediction !== "" ? [{ state: "pending" as const, lookup: { upstream: ticket.upstream, predictionId: prediction } }] : [];
    });

  /**
   * A failed answer, with what the ticket cost and a lookup per accepted prediction, retiring
   * the cached clones the upstream said are gone.
   * @param ticket - The ticket.
   * @param reason - Why.
   * @param warnings - Anything to log.
   * @returns The answer.
   */
  const failed = (ticket: Ticket, reason: Error, warnings: MediaWarning[] = []): MediaAnswer => {
    const retired = reason instanceof UpstreamTaskFailed
      ? carried(ticket).cached.flatMap(({ kind, id }) => {
        if (!adapterFor(ticket.upstream).gone(kind, reason.upstreamError, id)) return [];
        return ticket.clones.filter((c) => c.upstream === ticket.upstream && c.kind === kind && c.upstreamId === id);
      })
      : [];
    const notes = retired.map((c) => ({ code: "upstream_clone_retired", detail: { upstream: c.upstream, kind: c.kind, upstreamId: c.upstreamId } }));
    return { state: "failed", reason, costs: [...ticket.costs, ...acceptedLookups(ticket)], ...common({ retiredClones: retired, warnings: [...warnings, ...notes] }) };
  };

  /**
   * Finish a run whose steps are all done: its outputs and what each prediction cost.
   * @param ticket - The ticket.
   * @param bounds - The call's deadline and signal; the billing reads share one side request's bounds within them (`sideBounds`).
   * @param extra - Clones and warnings to carry.
   * @returns The done answer, or failed when the run produced no output.
   */
  const finish = async (ticket: Ticket, bounds: RequestBounds, extra: Partial<AnswerCommon>): Promise<MediaAnswer> => {
    const done = carried(ticket);
    if (done.urls === undefined || done.urls.length === 0) return failed(ticket, new Error("The run produced no output"), extra.warnings);
    const costs = [...ticket.costs];
    const warnings = [...(extra.warnings ?? [])];
    const up = reach(ticket.upstream);
    // Outside the cap, as the worker read it: a run that finished must not queue behind new submits. The reads share
    // one side request's bounds, so a hung billing endpoint holds the outputs for SIDE_REQUEST_MS at most.
    const side = sideBounds(bounds);
    for (const prediction of done.predictions) {
      const read = await adapterFor(ticket.upstream).billed(up, prediction, side, false);
      costs.push(read.cost);
      warnings.push(...read.warnings);
    }
    return { state: "done", outputs: done.urls.map(mediaOutputOf), costs, servedBy: ticket.upstream, ...common({ ...extra, warnings }) };
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
   * @param chosen - The caller's mode.
   * @param planOptions - The task's source keys, live clones and known clip lengths (by our param name).
   * @returns The plan.
   * @throws {NoUpstreamAvailable} When no upstream of the route is configured and able to take the run.
   * @throws {UpstreamRequestRejected} When the route names an upstream the model is not bound to.
   */
  const route = async (model: string, input: MediaInput, chosen: Route, planOptions: PlanOptions): Promise<RoutePlan> => {
    const rules = provider.pricingRules(model);
    const { durations } = planOptions;
    // A source sent without a known length is priced as a lower bound, and ranks after every known price.
    const durationsMissing = Object.keys(input.params).filter((p) => isPresent(input.params[p]) && durations[p] === undefined);
    // The live clones leave out each call an upstream holds, as planSteps does.
    const run = { params: input.params, prompt: input.prompt, durations, placeholders: [], durationsMissing, known: { sourceKeys: planOptions.sourceKeys, clones: planOptions.clones } };
    const candidates = await Promise.all(candidatesOf(config, model, keyOf).map(async (c): Promise<Candidate> => {
      const read = await assess(rules, c.upstream, run);
      // The rules come from the same configuration as the candidates, so every candidate has one; undefined is for the type.
      /* v8 ignore next -- @preserve */
      if (read === undefined) return c;
      return "rejected" in read ? { ...c, unsupported: read.rejected } : { ...c, estimate: { usd: read.estimate.usd, atLeast: read.estimate.bound === "at_least" } };
    }));
    return planRoute(model, chosen, candidates);
  };

  /**
   * A warning for each upstream skipped because a check of the run could not be made on it.
   * @param model - The model.
   * @param skipped - Why the upstreams were skipped.
   * @returns The warnings.
   */
  const checkFailures = (model: string, skipped: readonly UnavailableReason[]): MediaWarning[] =>
    skipped.flatMap((r) => (r.kind === "unsupported_input" && "reason" in r && r.evaluationError !== undefined
      ? [{ code: "input_check_failed", detail: { model, upstream: r.upstream, reason: r.reason, error: r.evaluationError } }]
      : []));

  /**
   * The first ticket of a run and what to log about its planning, or the failed answer when no upstream can take it.
   * @param model - The model.
   * @param input - The run.
   * @param chosen - The caller's mode.
   * @param planOptions - The task's key, source keys, clones and known clip lengths.
   * @returns The ticket on the first upstream of the order and its warnings, or the answer.
   * @throws {UpstreamRequestRejected} When the route names an upstream the model is not bound to.
   */
  const open = async (
    model: string,
    input: MediaInput,
    chosen: Route,
    planOptions: PlanOptions,
  ): Promise<{ opened: Omit<Ticket, "steps">; warnings: MediaWarning[] } | MediaAnswer> => {
    let plan: RoutePlan;
    try {
      plan = await route(model, input, chosen, planOptions);
    } catch (error) {
      if (error instanceof NoUpstreamAvailable) return { state: "failed", reason: error, costs: [], ...common({ warnings: checkFailures(model, error.reasons) }) };
      throw error;
    }
    const [first, ...rest] = plan.order;
    const opened = ticketBase(model, input, chosen, planOptions, { upstream: first!.upstream, next: rest.map((c) => c.upstream), reasons: plan.skipped, accepted: false });
    return { opened, warnings: checkFailures(model, plan.skipped) };
  };

  /**
   * A ticket before its steps are planned.
   * @param model - The model.
   * @param input - The run.
   * @param chosen - The caller's mode.
   * @param planOptions - The task's key, source keys and clones.
   * @param at - The upstream, the ones the run may move to, why earlier ones were skipped, and whether a step was accepted.
   * @returns The ticket.
   */
  const ticketBase = (model: string, input: MediaInput, chosen: Route, planOptions: PlanOptions, at: Pick<Ticket, "upstream" | "next" | "reasons" | "accepted">): Omit<Ticket, "steps"> => ({
    version: 1,
    model,
    route: chosen,
    phase: "send",
    input,
    idempotencyKey: planOptions.idempotencyKey,
    sourceKeys: planOptions.sourceKeys,
    clones: planOptions.clones,
    ...at,
    costs: [],
  });

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
   * @returns The send answer for the element step; failed when the image is refused or not an image type, no understand upstream can ever serve, or one refuses the request (its cost kept).
   * @throws {SendNotAccepted} When the image host could not be reached or dropped the read, or every understand upstream failed in a passing way.
   * @throws {DeadlinePassed} When the deadline cut the read or the description.
   * @throws {UnderstandInterrupted} When the understand call ended otherwise (a lost answer, an error it cannot read), carrying what was billed; other unknown errors are thrown as they are.
   */
  const describe = async (ticket: Ticket, index: number, bounds: CallBounds): Promise<MediaAnswer> => {
    const step = ticket.steps[index]!;
    const spec = bindingOf(ticket).extra_steps?.find((s) => s.kind === "element")?.describe;
    if (spec === undefined) throw new Error(`${ticket.model} has no description step on ${ticket.upstream}`);
    const signal = bounds.signal ? { signal: bounds.signal } : {};
    /**
     * Whether an error is an abort that came after the deadline.
     * @param error - The error.
     * @returns True when the deadline cut the call.
     */
    const cutByDeadline = (error: unknown): boolean =>
      cutAtDeadline(bounds) && inChain(error, (e) => e instanceof Aborted || e.name === "AbortError" || e.name === "TimeoutError");
    let media;
    try {
      media = await fetchMedia({ url: sourceOf(ticket, step), maxBytes: options.mediaLimits.maxMediaBytes, deadlineAt: bounds.deadlineAt, ...signal });
    } catch (error) {
      // Nothing paid has been sent yet: a host that may answer later has the caller clear its
      // sending mark and retry the ticket; any other refusal fails the run.
      const passing = error instanceof MediaRefused && error.kind === "unavailable" && error.status !== undefined && passingStatus(error.status, "media_submit");
      if (passing || error instanceof NotSent || error instanceof NoAnswer) throw new SendNotAccepted(ticket.upstream, error);
      if (error instanceof MediaRefused) return failed(ticket, error);
      if (cutByDeadline(error)) throw new DeadlinePassed(bounds.deadlineAt);
      throw error;
    }
    // Refused here, before any model call is spent being told the same.
    if (!IMAGE_TYPES.has(media.contentType)) return failed(ticket, new MediaRefused("unsupported_type"));
    let answer;
    try {
      answer = await provider.llm.understand({
        model: spec.model,
        question: spec.question,
        media: [media],
        maxOutputTokens: spec.max_output_tokens,
        deadlineAt: bounds.deadlineAt,
        ...signal,
      });
    } catch (error) {
      // The same rules as a media submit: a lasting answer fails the run, a passing one is retried by the caller.
      if (error instanceof NoUpstreamAvailable) {
        if (error.reasons.every((r) => r.kind !== "failed" || lasting(r.failure))) return failed({ ...ticket, costs: [...ticket.costs, ...error.costs] }, error);
        // The error stays as the cause: it carries what the answers it moved past cost.
        throw new SendNotAccepted(ticket.upstream, error);
      }
      if (error instanceof UpstreamRequestRejected) {
        return failed({ ...ticket, costs: [...ticket.costs, ...error.costs] }, error);
      }
      if (cutByDeadline(error)) throw new DeadlinePassed(bounds.deadlineAt, error);
      // UnderstandInterrupted and anything else go as they are: costsOf reads what they carry.
      throw error;
    }
    const description = answer.text.trim().slice(0, ELEMENT_DESCRIPTION_MAX);
    const steps = ticket.steps.map((s, i) => {
      if (i === index) return { ...s, status: "done" as const, output: {} };
      return i === index + 1 ? { ...s, description } : s;
    });
    return waiting(next(ticket, { steps, costs: [...ticket.costs, ...answer.costs] }));
  };

  return {
    async plan(model, input, chosen, planOptions) {
      const result = await open(model, input, chosen, planOptions);
      return "state" in result ? result : waiting(planned(result.opened), { warnings: result.warnings });
    },

    async send(raw, bounds) {
      const ticket = read(raw, "send");
      const at = current(ticket);
      if (at === undefined) throw new Error("The ticket has no step to send");
      if (at.step.kind === "describe") return describe(ticket, at.index, bounds);
      const body = bodyOf(ticket, at.step);
      let answer;
      try {
        answer = await capped(ticket.upstream, bounds, () => adapterFor(ticket.upstream).submit(reach(ticket.upstream), at.step.endpoint, body, { ...bounds, maxMediaBytes: options.mediaLimits.maxMediaBytes }, at.step.kind));
      } catch (error) {
        const failure = classify(error, adapterFor(ticket.upstream));
        if (failure === null || failure.kind === "no_answer") throw error;
        if (failure.kind === "aborted") throw cutAtDeadline(bounds) ? new DeadlinePassed(bounds.deadlineAt) : error;
        if (decide(failure, "media_submit", 0, 0) === "stop") {
          const refusal = error instanceof HttpStatus ? { status: error.status, cause: error } : { cause: error };
          const said = (error as Error).message + (error instanceof HttpStatus ? `: ${error.bodySnippet}` : "");
          return failed(ticket, new UpstreamRequestRejected(ticket.model, ticket.upstream, said, [], refusal));
        }
        const reasons: UnavailableReason[] = [...(ticket.reasons ?? []), failedReason(ticket.upstream, failure)];
        const [to, ...rest] = ticket.next;
        if (ticket.accepted || to === undefined) {
          if (lasting(failure.kind)) return failed(ticket, new NoUpstreamAvailable(ticket.model, reasons));
          throw new SendNotAccepted(ticket.upstream, error);
        }
        const moved = planned({ ...ticket, version: ticket.version + 1, upstream: to, next: rest, reasons });
        return waiting(moved, { warnings: [{ code: "upstream_switched", detail: { model: ticket.model, from: ticket.upstream, to, failure: failure.kind } }] });
      }
      if (answer.error !== undefined) {
        // Accepted and billed, but the step cannot go on: billed under its id, or missing without one.
        const id = answer.predictionId;
        const steps = id === undefined ? ticket.steps : ticket.steps.map((s, i) => (i === at.index ? { ...s, predictionId: id } : s));
        const costs: Cost[] = id === undefined ? [...ticket.costs, { state: "missing", reason: `${ticket.upstream} took the ${at.step.kind} step and named no id to bill it by` }] : ticket.costs;
        const warnings = id === undefined ? [{ code: "cost_unavailable", detail: { model: ticket.model, upstream: ticket.upstream, step: at.step.kind } }] : [];
        return failed({ ...ticket, accepted: true, steps, costs }, new UpstreamTaskFailed(ticket.upstream, answer.error), warnings);
      }
      if (answer.outputs !== undefined) {
        // Accepted and billed: an answer without a prediction id leaves nothing to look its cost up by.
        const accepted: Ticket = answer.predictionId === undefined
          ? { ...ticket, accepted: true, costs: [...ticket.costs, { state: "missing", reason: `${ticket.upstream} finished the ${at.step.kind} step at once with no prediction id to bill` }] }
          : { ...ticket, accepted: true, steps: ticket.steps.map((s, i) => (i === at.index ? { ...s, predictionId: answer.predictionId!, ...(answer.handle === undefined ? {} : { handle: answer.handle }) } : s)) };
        let output: StepOutput;
        try {
          output = outputOf(ticket, at.step, answer.outputs, answer.predictionId);
        } catch (error) {
          return failed(accepted, error as Error);
        }
        return completed(accepted, at.index, output, bounds, []);
      }
      const steps = ticket.steps.map((s, i) => (i === at.index ? { ...s, status: "submitted" as const, predictionId: answer.predictionId!, ...(answer.handle === undefined ? {} : { handle: answer.handle }) } : s));
      return waiting(next(ticket, { steps, accepted: true }));
    },

    async poll(raw, pollOptions) {
      const ticket = read(raw, "running");
      const bounds: RequestBounds = {
        ...(pollOptions.finalAsk === true ? {} : { deadlineAt: pollOptions.deadlineAt }),
        ...(pollOptions.signal ? { signal: pollOptions.signal } : {}),
        maxMediaBytes: options.mediaLimits.maxMediaBytes,
      };
      if (pollOptions.finalAsk !== true && Date.now() >= pollOptions.deadlineAt) throw new DeadlinePassed(pollOptions.deadlineAt);
      const at = current(ticket);
      if (at === undefined) return finish(ticket, bounds, {});
      let asked;
      try {
        asked = await capped(ticket.upstream, bounds, () => adapterFor(ticket.upstream).ask(reach(ticket.upstream), at.step.predictionId!, bounds, { binding: bindingOf(ticket), handle: at.step.handle, kind: at.step.kind }));
      } catch (error) {
        const resendable = error instanceof NoAnswer || error instanceof NotSent || (error instanceof HttpStatus && passingStatus(error.status, "media_submit"));
        if (error instanceof Aborted && pollOptions.finalAsk !== true && cutAtDeadline(pollOptions)) throw new DeadlinePassed(pollOptions.deadlineAt);
        if (!resendable) throw error;
        return waiting(ticket, { warnings: [{ code: "poll_request_failed", detail: { upstream: ticket.upstream, predictionId: at.step.predictionId, error: String(error) } }] });
      }
      if (asked.state === "running") {
        if (asked.handle === undefined) return waiting(ticket);
        return waiting(next(ticket, { steps: ticket.steps.map((s, i) => (i === at.index ? { ...s, handle: asked.handle } : s)) }));
      }
      if (asked.state === "failed") return failed(ticket, new UpstreamTaskFailed(ticket.upstream, asked.error));
      let output: StepOutput;
      try {
        output = outputOf(ticket, at.step, asked.outputs, at.step.predictionId);
      } catch (error) {
        return failed(ticket, error as Error);
      }
      return completed(ticket, at.index, output, bounds, []);
    },

    abandon(raw) {
      const ticket = raw as unknown as Ticket;
      return { costs: [...ticket.costs, ...acceptedLookups(ticket)] };
    },

    async recover(raw) {
      const ticket = read(raw, "send");
      const at = current(ticket);
      return waiting(ticket, { warnings: [{ code: "potential_duplicate_cost", detail: { model: ticket.model, upstream: ticket.upstream, step: at?.step.kind } }] });
    },

    async ticketFromLegacy(model, input, chosen, planOptions, legacy) {
      if (!isPresent(legacy.providerTaskId) && (legacy.steps ?? []).length === 0) return this.plan(model, input, chosen, planOptions);
      // Runs before the provider layer all ran on WaveSpeed, which took them: the run stays on the model's WaveSpeed
      // binding of the lowest weight whatever routing or the input checks would choose now, and never moves on.
      const binding = (config.models[model] ?? []).filter((b) => config.upstreams[b.upstream]?.kind === "wavespeed").sort((x, y) => x.weight - y.weight)[0];
      // Without a WaveSpeed binding no upstream can resume the run WaveSpeed took, and none has a reason of its own to name.
      if (binding === undefined) return { state: "failed", reason: new NoUpstreamAvailable(model, []), costs: [], ...common() };
      const candidate = candidateOf(config, binding.upstream, binding.weight, keyOf);
      if (!candidate.configured) {
        return { state: "failed", reason: new NoUpstreamAvailable(model, [{ upstream: candidate.upstream, kind: "missing_key", envVar: candidate.envVar }]), costs: [], ...common() };
      }
      const base = ticketBase(model, input, chosen, planOptions, { upstream: binding.upstream, next: [], reasons: [], accepted: true });
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
          return failed({ ...base, steps, costs }, new UpstreamTaskFailed(base.upstream, typeof output.error === "string" ? output.error : `step ${row.kind} failed`));
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
        // A clone step not yet sent takes the cache as a fresh plan does (and as run-steps did).
        const cached = row.status === "pending" ? cachedOutput({ ...base, steps }, step) : undefined;
        if (cached !== undefined) {
          steps.push({ ...step, status: "done", output: cached });
          continue;
        }
        const describes = row.kind === "element" && row.status === "pending" && step.description === undefined
          && binding.extra_steps?.find((s) => s.kind === "element")?.describe !== undefined;
        if (describes) steps.push({ kind: "describe", endpoint: "", ...(param === undefined ? {} : { param }), itemIndex: row.itemIndex, status: "pending" });
        steps.push(step);
      }
      return waiting({ ...base, steps, costs });
    },
  };
}
