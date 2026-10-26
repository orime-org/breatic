// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The main model's context window, from OpenRouter's endpoint list (inner#1567).
 *
 * OpenRouter keeps a conversation on one upstream (`callOptionsFor`'s
 * `session`), so the window a turn can count on is the smallest
 * `context_length` among the model's endpoints, not the model-level figure:
 * stuck on the smallest provider, the larger one overflows. Fetched, cached and
 * retried like the picture capability, with the same three timings.
 */

import { httpRequest } from "@breatic/shared";
import { waitForShared } from "@domain/agent/wait-for-shared.js";

/** Timeout and cache intervals for the endpoint lookup. */
export interface ModelContextWindowPolicy {
  timeoutMs: number;
  ttlMs: number;
  retryMs: number;
}

/** One model's cached answer and its clocks. */
interface CachedWindow {
  window: number | undefined;
  freshUntil: number;
  retryAfter: number;
  refreshing: Promise<void> | undefined;
}

const cache = new Map<string, CachedWindow>();

/**
 * The smallest positive context length among a model's endpoints.
 * @param endpoints - The endpoints as OpenRouter lists them.
 * @returns The window, or undefined when no endpoint states one.
 * @throws {never} Never.
 */
export function minEndpointContext(endpoints: readonly unknown[]): number | undefined {
  const lengths = endpoints.flatMap((endpoint) => {
    const value = (endpoint as { context_length?: unknown } | null)?.context_length;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? [value] : [];
  });
  return lengths.length === 0 ? undefined : Math.min(...lengths);
}

/**
 * Refresh one model's window under its own deadline.
 * @param modelId - The OpenRouter model id.
 * @param entry - Its cache entry, updated in place.
 * @param policy - Timeout and cache intervals.
 * @returns Completion once the entry's clocks are updated.
 * @throws {never} Failures keep the last answer and enter cooldown.
 */
async function refresh(modelId: string, entry: CachedWindow, policy: ModelContextWindowPolicy): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Model endpoints deadline", "TimeoutError")), policy.timeoutMs);
  try {
    const response = await httpRequest(`https://openrouter.ai/api/v1/models/${modelId}/endpoints`, {
      headers: { accept: "application/json" },
    }, { replaySafe: true, timeoutMs: policy.timeoutMs, signal: controller.signal });
    if (!response.ok) throw new Error(`Model endpoints answered HTTP ${String(response.status)}`);
    const body = await response.json() as { data?: { endpoints?: unknown } };
    const endpoints = body.data?.endpoints;
    if (!Array.isArray(endpoints)) throw new TypeError("The model endpoints answer had no endpoint list");
    const window = minEndpointContext(endpoints);
    if (window === undefined) throw new TypeError("No endpoint of the model stated a context length");
    entry.window = window;
    entry.freshUntil = Date.now() + policy.ttlMs;
    entry.retryAfter = 0;
  } catch {
    entry.retryAfter = Date.now() + policy.retryMs;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a model's context window, or undefined when it has never been read.
 * @param modelId - The model the turn runs on.
 * @param policy - Timeout and cache intervals.
 * @param signal - The waiting turn's stop signal.
 * @returns The smallest endpoint window, or undefined.
 * @throws {unknown} The stop signal's reason when the caller leaves.
 */
export async function resolveModelContextWindow(
  modelId: string,
  policy: ModelContextWindowPolicy,
  signal?: AbortSignal,
): Promise<number | undefined> {
  signal?.throwIfAborted();
  let entry = cache.get(modelId);
  if (entry === undefined) {
    entry = { window: undefined, freshUntil: 0, retryAfter: 0, refreshing: undefined };
    cache.set(modelId, entry);
  }
  const now = Date.now();
  if (now >= entry.freshUntil && now >= entry.retryAfter) {
    const one = entry;
    one.refreshing ??= refresh(modelId, one, policy).finally(() => { one.refreshing = undefined; });
  }
  if (entry.refreshing !== undefined) await waitForShared(entry.refreshing, signal);
  signal?.throwIfAborted();
  return entry.window;
}
