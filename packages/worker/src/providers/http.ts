/**
 * Shared HTTP utilities for AIGC provider transports.
 *
 * Provides retry with exponential backoff, generic polling,
 * nested JSON extraction, and WaveSpeed billing lookup.
 */

import type { ResolvedModel } from "@worker/providers/shared.js";
import { logger } from "@breatic/core";
import { getWorkerConfig } from "@breatic/core";

/** Lazy-loaded config values. */
function httpConfig() {
  const cfg = getWorkerConfig();
  return {
    maxRetries: cfg.http_max_retries,
    retryBaseDelay: cfg.http_retry_base_delay,
    defaultPollInterval: cfg.poll_interval,
    defaultMaxWait: cfg.poll_max_wait,
    billingTimeout: cfg.billing_timeout,
  };
}

/** Standard bearer auth headers. */
export function bearerHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Extract a value from a nested object using a key path.
 *
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
 * Make an HTTP request with exponential backoff retry on 429.
 *
 * @param url - Request URL
 * @param options - Fetch options (method, headers, body)
 * @param provider - Provider name for logging
 * @returns Parsed JSON response
 * @throws Error if retries exhausted
 */
export async function requestWithRetry(
  url: string,
  options: RequestInit,
  provider = "unknown",
): Promise<Record<string, unknown>> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= httpConfig().maxRetries; attempt++) {
    const response = await fetch(url, options);

    if (response.ok) {
      return (await response.json()) as Record<string, unknown>;
    }

    if (response.status === 429 && attempt < httpConfig().maxRetries) {
      const delay = httpConfig().retryBaseDelay * 2 ** attempt;
      logger.warn({ provider, url, attempt: attempt + 1, delay }, "rate_limited_retry");
      await sleep(delay);
      lastError = new Error(`${provider} 429 Too Many Requests`);
      continue;
    }

    const body = await response.text().catch(() => "");
    throw new Error(`${provider} HTTP ${response.status}: ${body}`);
  }

  throw lastError ?? new Error(`${provider} request failed after retries`);
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
 *
 * @param url - Poll URL
 * @param options - Polling configuration
 * @returns The full JSON response on success
 * @throws Error on failure status or timeout
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
      throw new Error(`${provider} task failed: ${errorMsg}`);
    }

    await sleep(interval);
    elapsed += interval;
  }

  throw new Error(`${provider} task did not complete within ${maxWait / 1000}s`);
}

/**
 * Query WaveSpeed billing API for actual cost.
 *
 * @param resolved - Resolved provider endpoint
 * @param taskId - Prediction UUID
 * @returns Cost in USD, or 0 if billing query fails
 */
export async function queryBilling(resolved: ResolvedModel, taskId: string): Promise<number> {
  try {
    const resp = await fetch(`${resolved.baseUrl}/billings/search`, {
      method: "POST",
      headers: bearerHeaders(resolved.apiKey),
      body: JSON.stringify({ prediction_uuids: [taskId] }),
      signal: AbortSignal.timeout(httpConfig().billingTimeout),
    });

    if (!resp.ok) return 0;
    const data = (await resp.json()) as { data?: Array<{ price?: number }> };
    return data.data?.[0]?.price ?? 0;
  } catch {
    logger.warn({ taskId }, "billing_query_failed");
    return 0;
  }
}

/** Sleep for the given milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
