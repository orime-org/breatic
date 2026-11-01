// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What every media upstream's adapter answers to. The runner, cost lookups and
 * configuration checks reach an upstream only through one of these, picked by
 * the upstream's kind (`adapterOf` in `media/adapters.ts`).
 */

import type { MediaBinding, UpstreamDecl } from "@provider/config/schema.js";
import type { Cost } from "@provider/cost.js";
import type { HttpStatus } from "@provider/http/errors.js";
import type { MediaWarning, StepKind } from "@provider/media/runner.js";

/** One upstream as a call reaches it. */
export interface Reach {
  name: string;
  decl: UpstreamDecl;
  key: string;
}

/** The bounds of one request. */
export interface RequestBounds {
  /** Epoch ms after which nothing is sent; absent for a final ask. */
  deadlineAt?: number;
  signal?: AbortSignal;
}

/** What a submit answered. */
export interface Submitted {
  predictionId: string | undefined;
  /** The outputs, when the submit already finished. */
  outputs: unknown[] | undefined;
  /** Data of the adapter's own that later questions about this prediction need; it survives a JSON round trip in the ticket. */
  handle?: Record<string, string>;
}

/** What one question about a prediction answered. */
export type Asked = { state: "running" } | { state: "done"; outputs: unknown[] } | { state: "failed"; error: string };

/** What one step answered, for the steps after it and for billing. */
export interface StepOutput {
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

/** What a step of a run needs to write its request and read its answer. */
export interface StepContext {
  /** The source url the step reads from its param. */
  source(): string;
  /** Our params and prompt of the run. */
  params: Readonly<Record<string, unknown>>;
  prompt: string;
  binding: MediaBinding;
  /** The voice id a clone step registers, unique per run. */
  customVoiceId: string;
  /** The cloned voice a speak step speaks with. */
  voiceId: string | undefined;
  /** For an element step: what its describe step wrote. */
  description: string | undefined;
  itemIndex: number | null;
  /** The param the step serves. */
  param: string | undefined;
}

/** How an adapter writes and reads one kind of extra step. */
export interface StepCodec {
  body(context: StepContext): Record<string, unknown>;
  /** @throws {Error} When the outputs lack what the step makes. */
  output(outputs: readonly unknown[], context: StepContext): StepOutput;
}

/** How a refused submit reads: a lasting answer of this upstream, or neither. */
export type Refusal = "model_not_found" | "insufficient_balance" | undefined;

/** One media upstream kind. */
export interface MediaAdapter {
  /** Submit one step; resent only when the HTTP module knows the upstream did not process it. */
  submit(reach: Reach, endpoint: string, body: Record<string, unknown>, bounds: RequestBounds): Promise<Submitted>;
  /** Ask once about a prediction. */
  ask(reach: Reach, predictionId: string, bounds: RequestBounds, context: { binding: MediaBinding; handle: Record<string, string> | undefined }): Promise<Asked>;
  /** What a prediction cost: pending when billing has not said yet, missing on the last attempt. */
  billed(reach: Reach, predictionId: string, bounds: RequestBounds, lastAttempt: boolean): Promise<{ cost: Cost; warnings: MediaWarning[] }>;
  /** What a refused submit says, read this upstream's way. */
  refusal(error: HttpStatus): Refusal;
  /** Whether the upstream's failure words say a cached clone is gone. */
  gone(kind: string, message: string, id: string): boolean;
  /** The extra step kinds this upstream speaks, and how. */
  steps: Partial<Record<Exclude<StepKind, "generate" | "describe">, StepCodec>>;
}

/**
 * A step's first structured output field.
 * @param outputs - The prediction's outputs.
 * @param field - The field.
 * @returns Its value.
 * @throws {Error} When the output carries no such string.
 */
export function outputField(outputs: readonly unknown[], field: string): string {
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
export function outputUrls(outputs: readonly unknown[]): string[] {
  if (outputs.length === 0 || !outputs.every((u): u is string => typeof u === "string" && u !== "")) {
    throw new Error("The upstream answered no output url");
  }
  return [...outputs];
}
