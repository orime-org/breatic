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
 * The name still fits — a caller still gets a retried request — but the
 * figures moved with the machinery, and four of them are different. Stated
 * exactly, because "it retries as it always did" was written here first and
 * is false on every one of these:
 *
 *   - Deliveries: 4 before (`attempt <= http_max_retries`, and that config
 *     value is 3), 3 now (`MAX_RETRIES = 2`, compiled into the transport).
 *   - Backoff base: 2000ms before (`http_retry_base_delay`), 1000ms now
 *     (`BASE_DELAY_MS`). The jitter formula itself is unchanged.
 *   - 408 was an ordinary failure and threw at once; it is now retried
 *     alongside 429, both being statements that the server did not process
 *     the request.
 *   - `Retry-After` was ignored entirely. It is now honoured, and a value
 *     above 60s stops the call rather than being shortened to something we
 *     find convenient.
 *
 * Those first two are the deliberate collapse of two config knobs that had
 * drifted into meaning different things; see `packages/shared/CLAUDE.md`.
 *
 * `replaySafe: false` for every call, which is a statement about the vendor
 * rather than a preference: a submit spends money a second time, and the
 * read-only endpoints did not retry a 5xx before either, so declaring them
 * safe would change behaviour as well as misstate the endpoint.
 * @param url - Request URL.
 * @param options - Fetch options (method, headers, body). Any `signal` here is
 *   discarded — the transport supplies its own deadline from `timeoutMs`.
 * @param provider - Provider name, used to word the failure.
 * @param timeoutMs - How long ONE delivery may take. Omitted leaves the
 *   transport's own default in place.
 * @returns Parsed JSON response.
 * @throws {Error} On any non-ok status, carrying the vendor's response body —
 *   it is the only diagnostic these calls produce.
 * @throws {Error} The transport's failure, unwrapped, when the first delivery
 *   produces no response and no replay follows. With `replaySafe: false` that
 *   is the COMMON failure shape here: a per-model deadline expiring arrives
 *   as the transport's bare timeout Error, a refused connection as fetch's
 *   TypeError — neither wrapped in anything.
 * @throws {Error} The transport's `HttpRetryError` when replays happened and
 *   the LAST of them produced no response. Not "none of them": an earlier
 *   delivery may well have brought one back, which is why that type says so
 *   in its own words rather than in this one's.
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
