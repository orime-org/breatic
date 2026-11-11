// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Records a stream's model calls, and hands the calls whose cost is not in hand to the later lookup (#296).
 *
 * Each call is recorded from its end event at what provider says it cost, under the upstream that served it. A call
 * cut off before it ended has no end event: provider keeps its cost among the prepared call's pending costs, a lookup
 * or a missing cost, which `handOff` reads once the stream is over.
 */

import type { LanguageModelUsage, ProviderMetadata } from "ai";
import type { CostLookup, PendingCost } from "@breatic/provider";
import { handOffLookups, provider, type UsageRecorder } from "@breatic/domain";

/** What a model call's end event carries, as far as this reads it. */
export interface ModelCallEnd {
  usage: LanguageModelUsage;
  providerMetadata?: ProviderMetadata;
}

/** One stream's watch. */
export interface ModelCallWatch {
  /** Call from `onLanguageModelCallEnd`; records the call. */
  callEnded(event: ModelCallEnd): void;
  /** The upstream that served the stream's calls, once one ended or was cut off; what its charge names. */
  served(): string | undefined;
  /** Call once the stream is over; records what was cut off and queues the lookup of every cost not in hand. */
  handOff(): Promise<void>;
}

/**
 * Watch one stream's model calls.
 * @param usage - The operation's recorder; rows and lookups go under its operation.
 * @param call - The model the stream calls, and what a ledger row says the charge was for.
 * @param call.model - The model id.
 * @param call.description - What the ledger row says the charge was for.
 * @param pendingCosts - The prepared call's `pendingCosts`.
 * @returns The watch.
 */
export function watchModelCalls(
  usage: UsageRecorder,
  call: { model: string; description: string },
  pendingCosts: () => readonly PendingCost[],
): ModelCallWatch {
  let served: string | undefined;
  return {
    callEnded(event) {
      const upstream = provider().llm.servedBy(event);
      served = upstream ?? served;
      const cost = provider().llm.costOf({ model: call.model, usage: event.usage, providerMetadata: event.providerMetadata });
      usage.recordModelCall({ source: "model", model: call.model, upstream: upstream ?? "", cost });
    },
    served: () => served,
    async handOff() {
      const cutOff: CostLookup[] = [];
      for (const pending of pendingCosts()) {
        if (pending.state === "pending") {
          cutOff.push(pending.lookup);
          served ??= pending.lookup.upstream;
          continue;
        }
        const { upstream, ...cost } = pending;
        served ??= upstream;
        usage.recordModelCall({ source: "model", model: call.model, upstream, cost });
      }
      const lookups = [...usage.awaitingLookup(), ...cutOff];
      if (lookups.length === 0) return;
      await handOffLookups(lookups, usage.operation, { model: call.model, description: call.description, charge: true });
    },
  };
}
