// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { httpRequest } from "@breatic/shared";
import { waitForShared } from "@domain/agent/wait-for-shared.js";

/** The fixed configuration snapshot used for this turn's capability lookup. */
export interface ModelPictureCapabilityPolicy {
  override: "auto" | "yes" | "no";
  timeoutMs: number;
  ttlMs: number;
  retryMs: number;
}

/** The last successful directory survives failed refreshes. */
let catalog: ReadonlyMap<string, boolean> | undefined;
let freshUntil = 0;
let retryAfter = 0;
let refreshing: Promise<void> | undefined;

/**
 * Read picture support from a valid public model directory.
 * @param value - The directory's parsed response.
 * @returns Picture support keyed by the exact provider model identifier.
 * @throws {TypeError} When the answer is not a model directory.
 */
function readCatalog(value: unknown): ReadonlyMap<string, boolean> {
  if (typeof value !== "object" || value === null || !("data" in value) || !Array.isArray(value.data)) {
    throw new TypeError("The model directory did not contain a model list");
  }
  const result = new Map<string, boolean>();
  for (const row of value.data as unknown[]) {
    if (typeof row !== "object" || row === null || !("id" in row) || typeof row.id !== "string") continue;
    const architecture: unknown = "architecture" in row ? row.architecture : undefined;
    const modalities: unknown = typeof architecture === "object" && architecture !== null && "input_modalities" in architecture
      ? architecture.input_modalities : undefined;
    result.set(row.id, Array.isArray(modalities) && modalities.includes("image"));
  }
  return result;
}

/**
 * Refresh the shared directory under its own deadline, independently of turn stops.
 * @param policy - The current query's timeout and cache intervals.
 * @returns Completion after success or failure has updated the cache clocks.
 * @throws {never} Query failures retain the last directory and enter cooldown.
 */
async function refreshCatalog(policy: ModelPictureCapabilityPolicy): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException("Model directory deadline", "TimeoutError");
      controller.abort(error);
      reject(error);
    }, policy.timeoutMs);
  });
  try {
    const reading = (async (): Promise<ReadonlyMap<string, boolean>> => {
      const response = await httpRequest("https://openrouter.ai/api/v1/models", {
        headers: { accept: "application/json" },
      }, { replaySafe: true, timeoutMs: policy.timeoutMs, signal: controller.signal });
      if (!response.ok) throw new Error(`Model directory answered HTTP ${String(response.status)}`);
      return readCatalog(await response.json() as unknown);
    })();
    const next = await Promise.race([reading, expired]);
    catalog = next;
    freshUntil = Date.now() + policy.ttlMs;
    retryAfter = 0;
  } catch {
    retryAfter = Date.now() + policy.retryMs;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Resolve picture capability once for the turn's selected model.
 * @param modelId - The exact model identifier selected by the agent factory.
 * @param policy - Explicit override and model-directory cache settings.
 * @param signal - The waiting turn's stop signal.
 * @returns Whether native image messages are supported for this turn.
 * @throws {unknown} The stop signal's reason when the caller leaves.
 */
export async function resolveModelPictureCapability(
  modelId: string,
  policy: ModelPictureCapabilityPolicy,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (policy.override !== "auto") return policy.override === "yes";
  const now = Date.now();
  if (now >= freshUntil && now >= retryAfter) {
    refreshing ??= refreshCatalog(policy).finally(() => { refreshing = undefined; });
    await waitForShared(refreshing, signal);
  } else if (refreshing !== undefined) {
    await waitForShared(refreshing, signal);
  }
  signal?.throwIfAborted();
  return catalog?.get(modelId) === true;
}
