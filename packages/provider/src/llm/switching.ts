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
import type { Cost } from "@provider/cost.js";
import { Aborted, NoAnswer, NotSent } from "@provider/http/errors.js";
import { openRouterModelNotFound, type ModelV4 } from "@provider/llm/vendors.js";
import { decide, type Failure } from "@provider/routing/decide.js";
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
 * The failure class of an error a model call threw, read down its cause chain.
 * @param error - What the call threw.
 * @returns Its class, or null for an error that is none of them.
 */
export function classifyLlm(error: unknown): Failure | null {
  const seen = new Set<unknown>();
  for (let current: unknown = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current instanceof NotSent) return { kind: "not_sent" };
    if (current instanceof NoAnswer) return { kind: "no_answer" };
    if (current instanceof Aborted || current.name === "AbortError" || current.name === "TimeoutError") return { kind: "aborted" };
  }
  if (APICallError.isInstance(error) && typeof error.statusCode === "number") {
    if (openRouterModelNotFound(error.statusCode, error.responseBody)) return { kind: "model_not_found" };
    return { kind: "http_status", status: error.statusCode };
  }
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
  const cost = (metadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
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
   * @returns What it answered and who served it.
   * @throws {unknown} The call's own error when it may not move on, or NoUpstreamAvailable.
   */
  private async attempt<T>(run: (candidate: Candidate) => Promise<T>): Promise<{ value: T; servedBy: Candidate }> {
    const pinned = this.pinned;
    if (pinned !== undefined) {
      for (let retries = 0; ; retries++) {
        try {
          return { value: await run(pinned), servedBy: pinned };
        } catch (error) {
          const failure = classifyLlm(error);
          if (failure === null || decide(failure, "llm_before_content", retries, this.setup.maxRetries) !== "retry") throw error;
        }
      }
    }
    const served = await tryInOrder(this.setup.plan, { phase: "llm_before_content", maxRetries: this.setup.maxRetries, attempt: run, classify: classifyLlm });
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
    const lookup = this.setup.tracksGenerations(upstream) && generationId !== undefined && reportedCost(metadata) === undefined
      ? { costRef: { upstream, generationId } }
      : {};
    return { ...this.setup.breatic, upstream, ...lookup };
  }

  /**
   * One model call, whole.
   * @param options - The AI SDK's call options.
   * @returns The answer, its metadata naming the upstream that served it.
   * @throws {unknown} As `attempt` throws.
   */
  async doGenerate(options: CallOptions): Promise<GenerateResult> {
    const { value, servedBy } = await this.attempt((c) => Promise.resolve(this.setup.modelFor(c).doGenerate(options)));
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
    const switching = this.pinned === undefined;
    const { value, servedBy } = await this.attempt(async (c) => {
      const result = await this.setup.modelFor(c).doStream(options);
      const reader = result.stream.getReader();
      const held: StreamPart[] = [];
      if (!switching) return { result, reader, held };
      for (;;) {
        let read: ReadableStreamReadResult<StreamPart>;
        try {
          read = await reader.read();
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          throw error;
        }
        if (read.done) break;
        if (read.value.type === "error") {
          await reader.cancel().catch(() => undefined);
          throw read.value.error;
        }
        held.push(read.value);
        if (CONTENT.has(read.value.type) || read.value.type === "finish") break;
      }
      return { result, reader, held };
    });
    const { result, reader, held } = value;
    const upstream = servedBy.upstream;
    const { pending } = this.setup;
    let generationId: string | undefined;
    let broken = false;
    /**
     * Note the generation a part names and mark the finish with who served it.
     * @param part - One part of the stream.
     * @returns The part to hand on.
     */
    const pass = (part: StreamPart): StreamPart => {
      if (part.type === "error") broken = true;
      if (part.type === "response-metadata" && isGenerationId(part.id) && this.setup.tracksGenerations(upstream)) {
        generationId = part.id;
        pending.set(generationId, { state: "pending", lookup: { upstream, generationId } });
      }
      if (part.type !== "finish") return part;
      // A stream cut short still ends with a finish; its generation is billed whole and stays to be looked up.
      if (generationId !== undefined && !broken && part.finishReason.unified !== "error") pending.delete(generationId);
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
