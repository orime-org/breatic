// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Records a stream's model calls, and hands an OpenRouter call whose cost is
 * not in hand to the later lookup (#296).
 *
 * A call that ends normally is recorded from its end event. An OpenRouter
 * call whose end event carries no cost, or that was cut off before it ended,
 * is looked up by its generation id once the generation is over. The id comes
 * on the provider's raw chunks, which the SDK passes to `onChunk` only when
 * asked for. A model reached directly has no lookup, and its interrupted call
 * is not recorded.
 */

import {
  openRouterCost,
  resolveProvider,
  trackOpenGeneration,
  type ModelCallUsage,
  type UsageRecorder,
} from "@breatic/domain";

import { enqueueUsageLookup } from "@server/agent/usage-lookup-queue.js";

/** What a model call's end event carries, as far as this reads it. */
export interface ModelCallEnd {
  responseId: string;
  usage: ModelCallUsage;
  providerMetadata?: Record<string, unknown>;
}

/** One stream's watch. */
export interface ModelCallWatch {
  /** Spread into the `streamText` options. */
  streamOptions: {
    includeRawChunks: true;
    onChunk: (event: { chunk: { type: string; rawValue?: unknown } }) => void;
  };
  /** Call from `onLanguageModelCallEnd`; records the call or keeps it for the lookup. */
  callEnded(event: ModelCallEnd): void;
  /** Call once the stream is over; queues the lookup of every OpenRouter call whose cost is not in hand. */
  handOff(): Promise<void>;
}

/**
 * Watch one stream's model calls.
 * @param usage - The operation's recorder; rows and lookups go under its operation.
 * @param call - The model the stream calls, and what a ledger row says the charge was for.
 * @param call.model - The model id.
 * @param call.description - What the ledger row says the charge was for.
 * @returns The watch.
 */
export function watchModelCalls(
  usage: UsageRecorder,
  call: { model: string; description: string },
): ModelCallWatch {
  const provider = resolveProvider(call.model);
  const open = trackOpenGeneration();
  const lookups = new Set<string>();
  return {
    streamOptions: {
      includeRawChunks: true,
      onChunk: ({ chunk }) => {
        if (chunk.type === "raw") open.seen(chunk.rawValue);
      },
    },
    callEnded(event) {
      open.ended(event.responseId);
      if (provider === "openrouter" && openRouterCost(event.providerMetadata) === undefined) {
        lookups.add(event.responseId);
        return;
      }
      usage.recordModelCall({
        source: "model",
        model: call.model,
        provider,
        usage: event.usage,
        providerMetadata: event.providerMetadata,
      });
    },
    async handOff() {
      if (provider !== "openrouter") return;
      const pending = open.pending();
      if (pending !== undefined) lookups.add(pending);
      for (const generationId of lookups) {
        await enqueueUsageLookup({
          generationId,
          model: call.model,
          ...usage.operation,
          source: "model",
          description: call.description,
        });
      }
    },
  };
}
