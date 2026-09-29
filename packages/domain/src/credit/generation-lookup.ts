// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The cost of an OpenRouter call that was cut off before it reported one (#296).
 *
 * A streamed call reports its cost on its last chunk, which a stopped stream
 * never receives. OpenRouter keeps generating for providers that cannot be
 * cancelled and bills the whole response, so the cost is only settled once
 * the generation is over; its `/generation` endpoint answers it by id.
 */

import { httpRequest } from "@breatic/shared";

import type { UsageFeature, UsageSource } from "@domain/credit/usage-recorder.js";

/** The queue the later lookup travels on. */
export const USAGE_LOOKUP_QUEUE = "usage-lookup";

/** One interrupted call, as the worker receives it. */
export interface UsageLookupJob {
  generationId: string;
  model: string;
  operationKey: string;
  feature: UsageFeature;
  source: UsageSource;
  actorUserId: string;
  projectId: string | null;
  /** What the ledger row says the charge was for. */
  description: string;
}

/**
 * The generation id on one of OpenRouter's streamed chunks.
 * @param rawValue - The chunk as the provider parsed it.
 * @returns The id, or undefined when the value is not an OpenRouter chunk.
 */
export function generationIdOf(rawValue: unknown): string | undefined {
  if (typeof rawValue !== "object" || rawValue === null) return undefined;
  const id = (rawValue as { id?: unknown }).id;
  return typeof id === "string" && id.startsWith("gen-") ? id : undefined;
}

/** Which model call of a stream has started and not ended. */
export interface OpenGeneration {
  /** Hand it every raw chunk of the stream. */
  seen(rawValue: unknown): void;
  /**
   * Call when a model call ended; its id is closed for good, so a raw chunk
   * of it that a slow reader receives afterwards does not open it again.
   */
  ended(generationId: string | undefined): void;
  /** The generation still open, if any. */
  pending(): string | undefined;
}

/**
 * Track the one model call a stream has open. A stream runs its calls one
 * after another, so there is at most one.
 * @returns The tracker.
 */
export function trackOpenGeneration(): OpenGeneration {
  let open: string | undefined;
  const closed = new Set<string>();
  return {
    seen(rawValue) {
      const id = generationIdOf(rawValue);
      if (id !== undefined && !closed.has(id)) open = id;
    },
    ended(generationId) {
      const id = generationId ?? open;
      if (id !== undefined) closed.add(id);
      open = undefined;
    },
    pending() {
      return open;
    },
  };
}

/**
 * Ask OpenRouter what a generation cost.
 * @param generationId - The id its chunks carried.
 * @param apiKey - The OpenRouter key.
 * @returns The cost in US dollars, or undefined while the generation is not
 *   there yet.
 * @throws {Error} When OpenRouter refuses the request for any other reason.
 */
export async function lookupGenerationCost(
  generationId: string,
  apiKey: string,
): Promise<number | undefined> {
  const url = `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`;
  const res = await httpRequest(
    url,
    { headers: { Authorization: `Bearer ${apiKey}` }, redirect: "manual" },
    { replaySafe: true },
  );
  if (res.status === 404) {
    void res.body?.cancel();
    return undefined;
  }
  if (!res.ok) {
    void res.body?.cancel();
    throw new Error(`OpenRouter generation lookup answered ${res.status}`);
  }
  const body = (await res.json()) as { data?: { total_cost?: unknown } };
  const cost = body.data?.total_cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}
