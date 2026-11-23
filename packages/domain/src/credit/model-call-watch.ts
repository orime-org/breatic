// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Records the model calls of one language-model use (a server stream, or a worker's prompt rewrite), and hands the
 * calls whose cost is not in hand to the later lookup (#296).
 *
 * Each call is recorded from its end event at what provider says it cost, under the upstream that served it. A call
 * cut off before it ended has no end event: provider keeps its cost among the prepared call's pending costs, a lookup
 * or a missing cost, which `handOff` reads once the stream is over.
 */

import type { LanguageModelUsage, ProviderMetadata } from "ai";
import type { LlmApi, PendingCost } from "@breatic/provider";
import { handOffLookups } from "@domain/credit/generation-lookup.js";
import type { AwaitedLookup, UsageRecorder } from "@domain/credit/usage-recorder.js";

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
 * @param call - The model the stream calls, what a ledger row says the charge was for, and the key row it runs on.
 * @param call.model - The model id.
 * @param call.description - What the ledger row says the charge was for.
 * @param call.keyId - The account key row the stream runs on (inner#1953); null or absent for our keys.
 * @param pendingCosts - The prepared call's `pendingCosts`.
 * @param llm - The language-model calls of the provider the call was prepared on, which say what it cost and where.
 * @returns The watch.
 */
export function watchModelCalls(
  usage: UsageRecorder,
  call: { model: string; description: string; keyId?: string | null },
  pendingCosts: () => readonly PendingCost[],
  llm: Pick<LlmApi, "costOf" | "servedBy">,
): ModelCallWatch {
  let served: string | undefined;
  return {
    callEnded(event) {
      const upstream = llm.servedBy(event);
      served = upstream ?? served;
      const cost = llm.costOf({ model: call.model, usage: event.usage, providerMetadata: event.providerMetadata });
      usage.recordModelCall({ source: "model", model: call.model, upstream: upstream ?? "", cost });
    },
    served: () => served,
    async handOff() {
      const cutOff: AwaitedLookup[] = [];
      for (const pending of pendingCosts()) {
        if (pending.state === "pending") {
          cutOff.push({ lookup: pending.lookup, source: "model", model: call.model, ...(pending.payer === undefined ? {} : { payer: pending.payer }) });
          served ??= pending.lookup.upstream;
          continue;
        }
        const { upstream, ...cost } = pending;
        served ??= upstream;
        usage.recordModelCall({ source: "model", model: call.model, upstream, cost });
      }
      const lookups = [...usage.awaitingLookup(), ...cutOff];
      if (lookups.length === 0) return;
      // handOffLookups decides by each lookup's payer which run uncharged on the key row (inner#1953).
      await handOffLookups(lookups, usage.operation, { description: call.description, charge: true, keyId: call.keyId });
    },
  };
}
