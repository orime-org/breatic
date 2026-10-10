// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The vendor-facing shape around the shared HTTP transport.
 *
 * Delivering a request — retrying it, backing off, honouring `Retry-After` —
 * belongs to `@breatic/shared` and is no longer done here. What remains is
 * everything particular to talking to an AIGC vendor: reading the JSON,
 * wording the failure so the vendor's own message survives, asking once about
 * a task it is running, and asking WaveSpeed what a prediction cost.
 */

import type { ResolvedModel } from "@worker/providers/shared.js";
import { logger } from "@breatic/core";
import { getWorkerConfig } from "@breatic/core";
import { httpRequest } from "@breatic/shared";
import { StillRunning } from "@worker/providers/still-running.js";

/**
 * Lazy-loaded HTTP config values, pulled from the worker config on each call.
 * @returns The poll / billing timing values used by the helpers below
 */
function httpConfig(): {
  pollInterval: number;
  billingTimeout: number;
} {
  const cfg = getWorkerConfig();
  return {
    pollInterval: cfg.poll_interval,
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
 *   - Deliveries: 4 before (the old loop ran while `attempt` stayed within a
 *     configured maximum of 3), 3 now (`MAX_RETRIES = 2`, compiled into the
 *     transport). Both config keys named here are gone as of the batch that
 *     added the naked-fetch guard: once the transport owned the count and the
 *     backoff, nothing read them, and a knob that changes nothing is worse
 *     than no knob.
 *   - Backoff base: 2000ms before (the second of those keys), 1000ms now
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
 * @throws {HttpStatusError} On any non-ok status, carrying the status and the
 *   vendor's response body — it is the only diagnostic these calls produce.
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
  throw new HttpStatusError(provider, response.status, body);
}

/** A vendor answered a request with a non-ok status. */
export class HttpStatusError extends Error {
  /**
   * Record the status and what the vendor said with it.
   * @param provider - The vendor.
   * @param status - The HTTP status.
   * @param body - The response body.
   */
  constructor(
    provider: string,
    readonly status: number,
    body: string,
  ) {
    super(`${provider} HTTP ${status}: ${body}`);
    this.name = "HttpStatusError";
  }
}

/**
 * Options for {@link pollOnce}: what differs between vendors — the status's
 * place in their JSON, and which values are terminal.
 */
export interface PollOptions {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  statusPath: string[];
  successStatuses: Set<string>;
  failureStatuses: Set<string>;
  errorPath?: string[];
  provider?: string;
}

/**
 * The upstream ran the task and reported it failed. A retry would ask about
 * the same failed task, so a caller that tracks steps marks the step failed
 * on this and on nothing else.
 */
export class UpstreamTaskFailed extends Error {
  /** The upstream's own words for why. */
  readonly upstreamError: string;

  /**
   * Record which upstream failed the task and what it said.
   * @param provider - The upstream that ran the task.
   * @param upstreamError - The upstream's own words for why.
   */
  constructor(provider: string, upstreamError: string) {
    super(`${provider} task failed: ${upstreamError}`);
    this.name = "UpstreamTaskFailed";
    this.upstreamError = upstreamError;
  }
}

/**
 * Whether a failed question about a task may get an answer if asked again:
 * a 5xx or a 429, or no answer at all (network, timeout).
 * @param err - What the question threw.
 * @returns True for a failure that says nothing about the task itself.
 */
function askAgain(err: unknown): boolean {
  // A body that is not JSON came back whole: it is an answer, not a dropped line.
  if (err instanceof SyntaxError) return false;
  if (!(err instanceof HttpStatusError)) return true;
  return err.status >= 500 || err.status === 429;
}

/**
 * Ask an upstream once about a task it is running.
 *
 * The job goes back to the queue between two questions, so nothing here
 * waits: a task still going, or a question that got no usable answer, names
 * the time to ask again (`poll_interval` in `config/worker.yaml`).
 * @param url - Poll URL
 * @param options - Vendor-specific polling shape
 * @returns The full JSON response when the task completed
 * @throws {UpstreamTaskFailed} When the upstream failed the task.
 * @throws {StillRunning} When the task is still going, or the question got a
 *   5xx, a 429 or no answer.
 * @throws {HttpStatusError} When the upstream answered the question with
 *   another 4xx — a statement about the task or the key, not a hiccup.
 */
export async function pollOnce(
  url: string,
  options: PollOptions,
): Promise<Record<string, unknown>> {
  const provider = options.provider ?? "unknown";
  const fetchUrl = options.params ? `${url}?${new URLSearchParams(options.params).toString()}` : url;

  let resp: Record<string, unknown>;
  try {
    resp = await requestWithRetry(fetchUrl, { method: "GET", headers: options.headers }, provider);
  } catch (err) {
    if (!askAgain(err)) throw err;
    logger.warn({ err, provider, url }, "poll_request_failed");
    throw new StillRunning(Date.now() + httpConfig().pollInterval);
  }

  const status = String(extractNested(resp, options.statusPath, "unknown"));
  if (options.successStatuses.has(status)) return resp;
  if (options.failureStatuses.has(status)) {
    const errorMsg = options.errorPath ? String(extractNested(resp, options.errorPath, "unknown")) : "unknown";
    // #1628: log at the poll layer (not only via the bubbled-up job error)
    // so vendor-side failures are attributable to the specific poll URL.
    logger.warn({ provider, url, status, errorMsg }, "poll_task_failed");
    throw new UpstreamTaskFailed(provider, errorMsg);
  }
  throw new StillRunning(Date.now() + httpConfig().pollInterval);
}

/**
 * How a billing line moves the prediction's cost: a deduction adds its price,
 * a refund takes its price back. A prediction that failed upstream carries one
 * of each at the same price (captured 2026-09-28 from a failed vocal-clone).
 */
const BILLING_SIGN: Readonly<Record<string, number>> = { deduct: 1, refund: -1 };

/** One line of a WaveSpeed billing answer. */
interface BillingLine {
  billing_type?: string;
  order?: { price?: number };
}

/**
 * Ask WaveSpeed what a finished prediction cost.
 *
 * The endpoint has no public documentation; the shape read here was captured
 * from a live TTS generation on 2026-09-03:
 *
 *     {"code":200,"data":{"page":1,"has_more":false,"items":[
 *       {"billing_type":"deduct",
 *        "order":{"origin_price":0.0026,"price":0.0026,"state":"done"},
 *        "prediction":{"model_uuid":"elevenlabs/eleven-v3","status":"completed"}}]}}
 *
 * Lines are summed because one prediction may carry more than one: deductions
 * add, refunds take back, and any other line type is left out.
 *
 * Every zero that comes from a lookup going wrong is logged — a refused
 * request, no deducting line, a line carrying no price. What is left answers
 * quietly: a zero summed from lines the vendor priced at zero (the generation
 * was free), or from a deduction the vendor refunded in full (a prediction
 * that failed upstream). A charge is taken on this number, so a lookup gone
 * wrong has to stay tellable apart from those two.
 * @param resolved - Resolved provider endpoint.
 * @param taskId - The vendor's prediction uuid.
 * @returns What the prediction cost in USD, or 0 when the vendor did not say.
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

    if (!resp.ok) {
      logger.warn({ taskId, status: resp.status }, "billing_query_rejected");
      return 0;
    }
    const body = (await resp.json()) as { data?: { items?: BillingLine[] } };
    const deducted = (body.data?.items ?? []).filter(
      (line) => line.billing_type === "deduct",
    );
    if (deducted.length === 0) {
      logger.warn({ taskId }, "billing_query_empty");
      return 0;
    }
    let total = 0;
    for (const line of body.data?.items ?? []) {
      const sign = BILLING_SIGN[line.billing_type ?? ""];
      if (sign === undefined) continue;
      const price = line.order?.price;
      if (typeof price !== "number") {
        logger.warn({ taskId, billingType: line.billing_type }, "billing_line_without_price");
        continue;
      }
      total += sign * price;
    }
    return total;
  } catch (err) {
    logger.warn({ err, taskId }, "billing_query_failed");
    return 0;
  }
}

