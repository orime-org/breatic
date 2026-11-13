// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** The direct token prices of `llm.yaml`, read at a moment. */

import type { LlmPrice, ProviderConfig } from "@provider/config/schema.js";

/** A model's direct prices, their `from` ascending. */
export type PriceEntries = ProviderConfig["llm"]["prices"][string];

/**
 * The direct price entry in effect at a moment: the last that took effect at or before it, else the first.
 * @param entries - A model's direct prices, their `from` ascending.
 * @param at - The moment, in epoch ms.
 * @returns The entry; its `from` is set when a later price is in effect.
 */
export function entryAt(entries: PriceEntries, at: number): PriceEntries[number] & { from?: string } {
  const [first, ...later] = entries;
  return later.findLast((e) => Date.parse(e.from) <= at) ?? first;
}

/**
 * The direct price in effect at a moment: the last that took effect at or before it (the first is in effect from the
 * start), every per-million-token price times its off-peak factor when the moment is outside the price's peak hours
 * (a UTC weekday of one window, a UTC time in `[from, to)`, a UTC date not among its holidays).
 * @param entries - A model's direct prices, their `from` ascending, or none.
 * @param at - The moment, in epoch ms.
 * @returns The price, or undefined when the model has none.
 */
export function priceAt(entries: PriceEntries | undefined, at: number): LlmPrice | undefined {
  if (entries === undefined) return undefined;
  const entry = entryAt(entries, at);
  const offPeak = entry.off_peak;
  const moment = new Date(at);
  const time = moment.toISOString().slice(11, 16);
  const peak = offPeak === undefined
    || (!offPeak.holidays.includes(moment.toISOString().slice(0, 10))
      && offPeak.peak_utc.some((w) => w.days.includes(moment.getUTCDay()) && time >= w.from && time < w.to));
  const factor = peak ? 1 : offPeak.factor;
  // Every number of a price is a per-million-token price, so each is scaled, a field added later included.
  return Object.fromEntries(Object.entries(entry).flatMap(([field, usd]) => (typeof usd === "number" ? [[field, usd * factor]] : []))) as LlmPrice;
}

/** The tokens a call is priced by: input counts every input token, the cached and the cache-written among them. */
export interface PricedTokens {
  input: number;
  cachedInput: number;
  written: number;
  output: number;
}

/**
 * What a call cost at a price: uncached input at the miss price, cached input at the hit price (else the miss price),
 * written input at the write price of its lifetime (else the miss price), output at the output price.
 * @param price - The price in effect.
 * @param tokens - The call's tokens.
 * @param cacheTtl - The lifetime the call cached for, when it did; a five-minute write otherwise.
 * @returns The cost in USD.
 */
export function tokenUsd(price: LlmPrice, tokens: PricedTokens, cacheTtl?: unknown): number {
  const writePrice = (cacheTtl === "1h" ? price.input_cache_write_1h_per_mtok : price.input_cache_write_5m_per_mtok) ?? price.input_cache_miss_per_mtok;
  return ((tokens.input - tokens.cachedInput - tokens.written) * price.input_cache_miss_per_mtok
    + tokens.cachedInput * (price.input_cache_hit_per_mtok ?? price.input_cache_miss_per_mtok)
    + tokens.written * writePrice
    + tokens.output * price.output_per_mtok) / 1_000_000;
}
