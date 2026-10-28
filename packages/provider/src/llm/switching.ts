// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The language model a prepared call hands the AI SDK (design 5.5). Its
 * first model call tries the route's upstreams in order until the first
 * content part arrives, and the upstream that sent it serves every later
 * step of the call: each vendor reads back only its own reasoning, so a
 * second step elsewhere would lose or be refused the first step's.
 */

import { APICallError } from "ai";
import { usdOf, type Cost } from "@provider/cost.js";
import { Aborted, HttpStatus, NoAnswer, NotSent } from "@provider/http/errors.js";
import { backoff, MAX_RETRY_AFTER_MS, retryAfterOf, wait } from "@provider/http/request.js";
import { inBandBodyOf, inBandStatusOf, type ModelV4, type Vendor } from "@provider/llm/vendors.js";
import { passingStatus, type Failure } from "@provider/routing/decide.js";
import type { Candidate, RoutePlan } from "@provider/routing/route.js";
import { tryInOrder } from "@provider/routing/try-in-order.js";

type CallOptions = Parameters<ModelV4["doStream"]>[0];
type GenerateResult = Awaited<ReturnType<ModelV4["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<ModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/** What a switching model needs from the call that made it. */
export interface SwitchingSetup {
  modelId: string;
  plan: RoutePlan;
  /** The upstream's model for this call. */
  modelFor: (candidate: Candidate) => ModelV4;
  /** How an upstream's vendor is spoken to, for reading its refusals. */
  vendorFor: (upstream: string) => Vendor;
  /** Whether an upstream reports a generation id to look its cost up by later. */
  tracksGenerations: (upstream: string) => boolean;
  maxRetries: number;
  /** The lookups of model calls opened and not finished, shared with the prepared call. */
  pending: Map<string, Cost>;
  /** Extra fields for `providerMetadata.breatic`. */
  breatic: Record<string, string>;
}

/** Parts that are the model's content: the switch boundary (design 5.5). */
const CONTENT = new Set(["text-delta", "reasoning-delta", "tool-input-start", "tool-input-delta", "tool-call", "file", "source"]);

/**
 * An error an answer carried before any content, as the vendor wrote it (often a plain
 * `{ code, message }` object): an error part of a stream, or the error on a gateway's
 * choice that wrote nothing.
 */
export class InBandError extends Error {
  /** The vendor's own error value. */
  readonly error: unknown;

  /**
   * Record the vendor's error value.
   * @param error - What the error part carried.
   */
  constructor(error: unknown) {
    super(`The answer carried an error before its content: ${JSON.stringify(error) ?? String(error)}`, { cause: error });
    this.name = "InBandError";
    this.error = error;
  }
}

/**
 * The failure class of a status and body, read with the answering vendor's own forms.
 * @param status - The status, or an in-band error's code.
 * @param body - The parsed error body.
 * @param vendor - The vendor that answered.
 * @returns The failure.
 */
function statusFailure(status: number, body: unknown, vendor: Vendor | undefined): Failure {
  const refusal = vendor?.refusal(status, body);
  return refusal === undefined ? { kind: "http_status", status } : { kind: refusal };
}

/**
 * The failure an error carried as a value stands for (an in-band error part, or the error
 * OpenRouter's SDK puts on a status-200 answer), read with the vendor's own forms.
 * @param value - The error value.
 * @param vendor - The vendor that answered.
 * @returns The failure, or undefined when the value names no status.
 */
function valueFailure(value: unknown, vendor: Vendor | undefined): Failure | undefined {
  const status = inBandStatusOf(vendor, value);
  return status === undefined ? undefined : statusFailure(status, inBandBodyOf(value), vendor);
}

/**
 * A response body parsed as JSON.
 * @param text - The body.
 * @returns The value, or undefined when it is not JSON.
 */
export function parsed(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The failure class of an error a model call threw, read down its cause chain.
 * @param error - What the call threw.
 * @param vendor - The vendor of the upstream that answered; its refusal forms are the only ones read.
 * @returns Its class, or null for an error that is none of them.
 */
export function classifyLlm(error: unknown, vendor?: Vendor): Failure | null {
  const seen = new Set<unknown>();
  for (let current: unknown = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current instanceof NotSent) return { kind: "not_sent" };
    if (current instanceof NoAnswer) return { kind: "no_answer" };
    if (current instanceof Aborted || current.name === "AbortError" || current.name === "TimeoutError") return { kind: "aborted" };
  }
  if (APICallError.isInstance(error) && typeof error.statusCode === "number") {
    // OpenRouter's SDK throws a 200 whose body is an error as a status-200 error carrying that
    // error as data; it is judged by its own code, as the same error in a stream is.
    const carried = error.statusCode === 200 && error.data !== undefined ? valueFailure(error.data, vendor) : undefined;
    if (carried !== undefined) return carried;
    return statusFailure(error.statusCode, parsed(error.responseBody), vendor);
  }
  if (error instanceof InBandError) return valueFailure(error.error, vendor) ?? null;
  if (error instanceof HttpStatus) return statusFailure(error.status, parsed(error.body), vendor);
  return null;
}

/**
 * Whether an id is an OpenRouter generation id.
 * @param id - The value.
 * @returns True for a `gen-` id.
 */
export function isGenerationId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith("gen-");
}

/**
 * The cost OpenRouter put on a response.
 * @param metadata - The provider metadata.
 * @returns The cost in USD, or undefined.
 */
export function reportedCost(metadata: unknown): number | undefined {
  return usdOf((metadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage?.cost);
}

/**
 * Wait before a retry on the same upstream (design 5.3): as long as the upstream
 * asked, up to a minute; beyond that the upstream is not retried. Otherwise a
 * full-jitter backoff. The wait ends with the call's signal.
 * @param error - What the attempt threw.
 * @param retry - The retry about to be made, from 1.
 * @param signal - The call's signal.
 * @returns Whether to retry or to leave the upstream.
 * @throws {Aborted} When the signal ends the wait.
 */
export async function pauseBeforeRetry(error: unknown, retry: number, signal: AbortSignal | undefined): Promise<"retry" | "switch"> {
  /**
   * One response header of the failure, from the AI SDK's error or provider's own.
   * @param name - The header, lower-case.
   * @returns Its value, or null.
   */
  const header = (name: string): string | null => {
    if (APICallError.isInstance(error)) return error.responseHeaders?.[name] ?? null;
    return error instanceof HttpStatus ? (error.headers?.get(name) ?? null) : null;
  };
  const ms = header("retry-after-ms")?.trim();
  const asked = ms !== undefined && /^\d+$/.test(ms) ? Number(ms) : retryAfterOf(header("retry-after"));
  if (asked !== undefined && asked > MAX_RETRY_AFTER_MS) return "switch";
  await wait(asked ?? backoff(retry), { replaySafe: false, ...(signal ? { signal } : {}) }, "the model call");
  return "retry";
}

/**
 * The lookup a finished call carries (design 3.6): an upstream that reports
 * generations, a generation id, and no cost reported on the answer.
 * @param upstream - The upstream that served the call.
 * @param tracksGenerations - Whether that upstream reports generations to look up.
 * @param generationId - The id the answer carried, if any.
 * @param metadata - The answer's provider metadata.
 * @returns The lookup, or undefined when there is nothing to look up.
 */
export function costRefOf(upstream: string, tracksGenerations: boolean, generationId: unknown, metadata: unknown): { upstream: string; generationId: string } | undefined {
  return tracksGenerations && isGenerationId(generationId) && reportedCost(metadata) === undefined ? { upstream, generationId } : undefined;
}

/** A language model that switches upstream before its first content and then stays. */
export class SwitchingModel implements ModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "breatic";
  readonly modelId: string;
  readonly supportedUrls: ModelV4["supportedUrls"];
  private pinned: Candidate | undefined;

  /**
   * Build the model of one prepared call.
   * @param setup - The call's route and upstream models.
   */
  constructor(private readonly setup: SwitchingSetup) {
    this.modelId = setup.modelId;
    // The first upstream's: the AI SDK downloads any other url itself.
    this.supportedUrls = setup.modelFor(setup.plan.order[0]!).supportedUrls;
  }

  /**
   * Run one model call: on the pinned upstream with its retries, or along the route.
   * @param run - The call on one upstream.
   * @param signal - The call's signal, which ends a wait before a retry.
   * @returns What it answered and who served it.
   * @throws {unknown} The call's own error when it may not move on, or NoUpstreamAvailable.
   */
  private async attempt<T>(run: (candidate: Candidate) => Promise<T>, signal: AbortSignal | undefined): Promise<{ value: T; servedBy: Candidate }> {
    const pinned = this.pinned;
    if (pinned !== undefined) {
      for (let retries = 0; ; retries++) {
        try {
          return { value: await run(pinned), servedBy: pinned };
        } catch (error) {
          // Pinned (design 12.4): only a request that never left and a passing status are retried, here
          // and never elsewhere; a missing model or balance is thrown at once, since a retry cannot fix it.
          const failure = classifyLlm(error, this.setup.vendorFor(pinned.upstream));
          const passing = failure?.kind === "not_sent" || (failure?.kind === "http_status" && passingStatus(failure.status, "llm_before_content"));
          if (!passing || retries >= this.setup.maxRetries) throw error;
          if ((await pauseBeforeRetry(error, retries + 1, signal)) === "switch") throw error;
        }
      }
    }
    const served = await tryInOrder(this.setup.plan, {
      phase: "llm_before_content",
      maxRetries: this.setup.maxRetries,
      attempt: run,
      classify: (error, c) => classifyLlm(error, this.setup.vendorFor(c.upstream)),
      pause: (error, retry) => pauseBeforeRetry(error, retry, signal),
    });
    const by = this.setup.plan.order.find((c) => c.upstream === served.servedBy)!;
    this.pinned = by;
    return { value: served.value, servedBy: by };
  }

  /**
   * The `breatic` metadata of a finished model call.
   * @param upstream - Who served it.
   * @param generationId - Its generation id, when the upstream gave one.
   * @param metadata - The call's provider metadata.
   * @returns The metadata to add.
   */
  private finished(upstream: string, generationId: string | undefined, metadata: unknown): Record<string, unknown> {
    const costRef = costRefOf(upstream, this.setup.tracksGenerations(upstream), generationId, metadata);
    return { ...this.setup.breatic, upstream, ...(costRef === undefined ? {} : { costRef }) };
  }

  /**
   * One model call, whole.
   * @param options - The AI SDK's call options.
   * @returns The answer, its metadata naming the upstream that served it.
   * @throws {unknown} As `attempt` throws.
   */
  async doGenerate(options: CallOptions): Promise<GenerateResult> {
    const { value, servedBy } = await this.attempt((c) => Promise.resolve(this.setup.modelFor(c).doGenerate(options)), options.abortSignal);
    const id = isGenerationId(value.response?.id) ? value.response.id : undefined;
    const breatic = this.finished(servedBy.upstream, id, value.providerMetadata);
    return { ...value, providerMetadata: { ...value.providerMetadata, breatic: breatic as Record<string, never> } };
  }

  /**
   * One model call, streamed; parts before the first content are held until it arrives.
   * @param options - The AI SDK's call options.
   * @returns The stream, its finish naming the upstream that served it.
   * @throws {unknown} As `attempt` throws.
   */
  async doStream(options: CallOptions): Promise<StreamResult> {
    const { value, servedBy } = await this.attempt(async (c) => {
      const result = await this.setup.modelFor(c).doStream(options);
      const reader = result.stream.getReader();
      const held: StreamPart[] = [];
      for (;;) {
        let read: ReadableStreamReadResult<StreamPart>;
        try {
          read = await reader.read();
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          throw error;
        }
        if (read.done) break;
        // Registered as soon as it is read: a call stopped before its content is still billed.
        const part = read.value;
        if (part.type === "response-metadata" && isGenerationId(part.id) && this.setup.tracksGenerations(c.upstream)) {
          this.setup.pending.set(part.id, { state: "pending", lookup: { upstream: c.upstream, generationId: part.id } });
        }
        if (part.type === "error") {
          await reader.cancel().catch(() => undefined);
          throw new InBandError(part.error);
        }
        held.push(read.value);
        if (CONTENT.has(read.value.type) || read.value.type === "finish") break;
      }
      return { result, reader, held };
    }, options.abortSignal);
    const { result, reader, held } = value;
    const upstream = servedBy.upstream;
    const { pending } = this.setup;
    let generationId: string | undefined;
    /**
     * Note the generation a part names and mark the finish with who served it.
     * @param part - One part of the stream.
     * @returns The part to hand on.
     */
    const pass = (part: StreamPart): StreamPart => {
      if (part.type === "response-metadata" && isGenerationId(part.id) && this.setup.tracksGenerations(upstream)) {
        generationId = part.id;
        pending.set(generationId, { state: "pending", lookup: { upstream, generationId } });
      }
      if (part.type !== "finish") return part;
      // A finish hands its generation over as costRef, error endings included. A stream the caller
      // stopped stays pending: the provider SDK still closes it with a finish, but the AI SDK reports
      // no end of the call after an abort, so that finish never reaches the caller.
      if (generationId !== undefined && options.abortSignal?.aborted !== true) pending.delete(generationId);
      const breatic = this.finished(upstream, generationId, part.providerMetadata);
      return { ...part, providerMetadata: { ...part.providerMetadata, breatic: breatic as Record<string, never> } };
    };
    const stream = new ReadableStream<StreamPart>({
      async pull(controller) {
        const part = held.shift();
        if (part !== undefined) {
          controller.enqueue(pass(part));
          return;
        }
        try {
          const read = await reader.read();
          if (read.done) controller.close();
          else controller.enqueue(pass(read.value));
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return { ...result, stream };
  }
}
