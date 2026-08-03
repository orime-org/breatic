// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The vendor-facing shape around the shared HTTP transport.
 *
 * Delivering a request — retrying it, backing off, honouring `Retry-After` —
 * belongs to `@breatic/shared` and is no longer done here. What remains is
 * everything particular to talking to an AIGC vendor: reading the JSON,
 * wording the failure so the vendor's own message survives, polling a task to
 * a terminal status, and asking WaveSpeed what a prediction cost.
 */

import type { ResolvedModel } from "@worker/providers/shared.js";
import { logger } from "@breatic/core";
import { getWorkerConfig } from "@breatic/core";
import { httpRequest } from "@breatic/shared";

/**
 * Lazy-loaded HTTP config values, pulled from the worker config on each call.
 * @returns The poll / billing timing values used by the helpers below
 */
function httpConfig(): {
  defaultPollInterval: number;
  defaultMaxWait: number;
  billingTimeout: number;
} {
  const cfg = getWorkerConfig();
  return {
    defaultPollInterval: cfg.poll_interval,
    defaultMaxWait: cfg.poll_max_wait,
    billingTimeout: cfg.billing_timeout,
  };
}

/**
 * Standard bearer auth headers.
 * @param apiKey - API key placed in the `Authorization: Bearer` header
 * @returns Headers with bearer auth and a JSON content type
 */
export function bearerHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Extract a value from a nested object using a key path.
 * @param data - Source object
 * @param path - Array of keys (e.g. `["data", "status"]`)
 * @param defaultValue - Fallback if path not found
 * @returns The extracted value or defaultValue
 */
export function extractNested(
  data: Record<string, unknown>,
  path: string[],
  defaultValue: unknown = undefined,
): unknown {
  let current: unknown = data;
  for (const key of path) {
    if (current !== null && typeof current === "object" && key in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return defaultValue;
    }
  }
  return current ?? defaultValue;
}

/**
 * Ask a vendor for JSON, retried by the shared transport.
 *
 * The name still fits: from a caller's side this retries exactly as it always
 * did — what changed is who does it. Every declaration below is a statement
 * about the vendor, not a preference:
 *
 *   - `replaySafe: false` for all of them. A submit spends the vendor's money
 *     a second time, and the read-only endpoints did not retry a 5xx before
 *     either, so declaring the endpoint safe would be both a change in
 *     behaviour and, for the submits, a false statement. A 429 or 408 is
 *     retried regardless — the server has said it did not process the request.
 *   - Whatever `signal` sits on `options` is ignored by the transport, which
 *     supplies its own deadline. That is why the deadline arrives as a figure.
 * @param url - Request URL.
 * @param options - Fetch options (method, headers, body). Any `signal` here is
 *   discarded in favour of `timeoutMs`.
 * @param provider - Provider name, used to word the failure.
 * @param timeoutMs - How long ONE delivery may take. Omitted leaves the
 *   transport's own default in place.
 * @returns Parsed JSON response.
 * @throws {Error} On any non-ok status, carrying the vendor's response body —
 *   it is the only diagnostic these calls produce.
 * @throws {HttpRetryError} When replays happened and none produced a response.
 */
export async function requestWithRetry(
  url: string,
  options: RequestInit,
  provider = "unknown",
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const response = await httpRequest(url, options, {
    replaySafe: false,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });

  if (response.ok) {
    return (await response.json()) as Record<string, unknown>;
  }

  const body = await response.text().catch(() => "");
  throw new Error(`${provider} HTTP ${response.status}: ${body}`);
}

/** Options for {@link pollUntilDone}. */
export interface PollOptions {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  statusPath: string[];
  successStatuses: Set<string>;
  failureStatuses: Set<string>;
  errorPath?: string[];
  interval?: number;
  maxWait?: number;
  provider?: string;
}

/**
 * Poll an async task endpoint until it reaches a terminal status.
 * @param url - Poll URL
 * @param options - Polling configuration
 * @returns The full JSON response on success
 * @throws {Error} on failure status or timeout
 */
export async function pollUntilDone(
  url: string,
  options: PollOptions,
): Promise<Record<string, unknown>> {
  const interval = options.interval ?? httpConfig().defaultPollInterval;
  const maxWait = options.maxWait ?? httpConfig().defaultMaxWait;
  const provider = options.provider ?? "unknown";
  let elapsed = 0;

  while (elapsed < maxWait) {
    const fetchUrl = options.params
      ? `${url}?${new URLSearchParams(options.params).toString()}`
      : url;

    const resp = await requestWithRetry(
      fetchUrl,
      { method: "GET", headers: options.headers },
      provider,
    );

    const status = String(extractNested(resp, options.statusPath, "unknown"));

    if (options.successStatuses.has(status)) {
      return resp;
    }
    if (options.failureStatuses.has(status)) {
      const errorMsg = options.errorPath
        ? String(extractNested(resp, options.errorPath, "unknown"))
        : "unknown";
      // #1628: log at the poll layer (not only via the bubbled-up job error)
      // so vendor-side failures are attributable to the specific poll URL.
      logger.warn({ provider, url, status, errorMsg }, "poll_task_failed");
      throw new Error(`${provider} task failed: ${errorMsg}`);
    }

    await sleep(interval);
    elapsed += interval;
  }

  // #1628: same rationale — make poll timeouts visible at this layer.
  logger.warn({ provider, url, maxWait }, "poll_timeout");
  throw new Error(`${provider} task did not complete within ${maxWait / 1000}s`);
}

/**
 * Query WaveSpeed billing API for actual cost.
 * @param resolved - Resolved provider endpoint
 * @param taskId - Prediction UUID
 * @returns Cost in USD, or 0 if billing query fails
 */
export async function queryBilling(resolved: ResolvedModel, taskId: string): Promise<number> {
  try {
    const resp = await httpRequest(
      `${resolved.baseUrl}/billings/search`,
      {
        method: "POST",
        headers: bearerHeaders(resolved.apiKey),
        body: JSON.stringify({ prediction_uuids: [taskId] }),
      },
      { replaySafe: false, timeoutMs: httpConfig().billingTimeout },
    );

    if (!resp.ok) return 0;
    const data = (await resp.json()) as { data?: Array<{ price?: number }> };
    return data.data?.[0]?.price ?? 0;
  } catch {
    logger.warn({ taskId }, "billing_query_failed");
    return 0;
  }
}

/**
 * Sleep for the given milliseconds.
 * @param ms - Milliseconds to sleep
 * @returns A promise that resolves after the delay elapses
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
