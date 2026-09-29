// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Watches a streamed model call for being cut off before it reported its
 * cost, and hands an OpenRouter one to the later lookup (#296).
 *
 * The generation id comes on the provider's raw chunks, which the SDK passes
 * to `onChunk` only when asked for. A call that ends normally is recorded by
 * `onLanguageModelCallEnd`; the caller says so with `ended()`. A model
 * reached directly has no lookup, and its interrupted call is not recorded.
 */

import { resolveProvider, trackOpenGeneration, type UsageFeature } from "@breatic/domain";

import { enqueueUsageLookup } from "@server/agent/usage-lookup-queue.js";

/** The operation a watched call belongs to. */
export interface WatchedOperation {
  model: string;
  operationKey: string;
  feature: UsageFeature;
  actorUserId: string;
  projectId: string | null;
  /** What the ledger row says the charge was for. */
  description: string;
}

/** One stream's watch. */
export interface InterruptedCallWatch {
  /** Spread into the `streamText` options. */
  streamOptions: {
    includeRawChunks: true;
    onChunk: (event: { chunk: { type: string; rawValue?: unknown } }) => void;
  };
  /** Call from `onLanguageModelCallEnd`. */
  ended(): void;
  /** Call once the stream is over; queues the lookup when a call was cut off. */
  handOff(): Promise<void>;
}

/**
 * Watch one stream.
 * @param operation - What the stream's calls are recorded and charged under.
 * @returns The watch.
 */
export function watchInterruptedCall(operation: WatchedOperation): InterruptedCallWatch {
  const open = trackOpenGeneration();
  return {
    streamOptions: {
      includeRawChunks: true,
      onChunk: ({ chunk }) => {
        if (chunk.type === "raw") open.seen(chunk.rawValue);
      },
    },
    ended: () => open.ended(),
    async handOff() {
      const generationId = open.pending();
      if (generationId === undefined || resolveProvider(operation.model) !== "openrouter") return;
      await enqueueUsageLookup({
        generationId,
        model: operation.model,
        operationKey: operation.operationKey,
        feature: operation.feature,
        source: "model",
        actorUserId: operation.actorUserId,
        projectId: operation.projectId,
        description: operation.description,
      });
    },
  };
}
