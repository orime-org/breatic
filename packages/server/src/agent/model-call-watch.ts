// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Records a stream's model calls, and hands the OpenRouter calls whose cost
 * is not in hand to the later lookup (#296).
 *
 * Each call is recorded from its end event under the OpenRouter generation id
 * it ran as; the recorder keeps the ones that reported no cost for the lookup.
 * A call cut off before it ended is looked up by the id on its raw chunks,
 * which the SDK passes to `onChunk` only when asked for.
 */

import {
  handOffLookups,
  isGenerationId,
  resolveProvider,
  trackOpenGeneration,
  type ModelCallUsage,
  type UsageRecorder,
} from "@breatic/domain";

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
  /** Call from `onLanguageModelCallEnd`; records the call. */
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
  return {
    streamOptions: {
      includeRawChunks: true,
      onChunk: ({ chunk }) => {
        if (chunk.type === "raw") open.seen(chunk.rawValue);
      },
    },
    callEnded(event) {
      // A stream whose first chunk is an in-band error never passes the id on
      // to the SDK, and the end event carries the SDK's own id instead.
      const generationId = isGenerationId(event.responseId) ? event.responseId : open.pending();
      open.ended(event.responseId);
      usage.recordModelCall({
        source: "model",
        model: call.model,
        provider,
        usage: event.usage,
        providerMetadata: event.providerMetadata,
        generationId,
      });
    },
    async handOff() {
      if (provider !== "openrouter") return;
      const cutOff = open.pending();
      const ids = cutOff === undefined ? usage.awaitingLookup() : [...usage.awaitingLookup(), cutOff];
      await handOffLookups(ids, usage.operation, { ...call, charge: true });
    },
  };
}
