// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Worker-side composition of the shared HTTP transport.
 *
 * The transport itself lives in `@breatic/shared` — it is business-agnostic
 * and the browser uses it too. This module supplies the two things a
 * library layer is not allowed to acquire for itself: configuration (from
 * `worker.yaml`) and a logger. It also hosts the one genuinely
 * vendor-specific call, WaveSpeed's billing lookup, which is a consumer of
 * the transport rather than part of it.
 *
 * `bearerHeaders` and `extractNested` moved to `@breatic/shared` outright:
 * they take no configuration and need no logger, so re-exporting them here
 * would be a pure pass-through with nothing to compose. Transports import
 * them from `@breatic/shared` directly.
 */

import { logger } from "@breatic/core";
import { getWorkerConfig } from "@breatic/core";
import {
  bearerHeaders,
  extractNested,
  httpRequest,
  httpRequestJson,
  pollUntilDone as sharedPollUntilDone,
  type GuardedResponse,
  type HttpRetryEvent,
  type PollEvent,
} from "@breatic/shared";

import type { ResolvedModel } from "@worker/providers/shared.js";

/**
 * Route transport telemetry into the worker's logger.
 *
 * The transport emits events instead of logging because library packages
 * must not log; this is the application-layer end of that contract. Without
 * it a vendor that intermittently 503s would retry silently and nobody
 * would know the provider was degraded.
 * @param event - A retry or poll event from the transport.
 */
function logTransportEvent(event: HttpRetryEvent | PollEvent): void {
  switch (event.type) {
    case "retry":
      logger.warn(
        {
          provider: event.label,
          url: event.url,
          attempt: event.attempt,
          delay: event.delayMs,
          reason: event.reason,
          status: event.status,
        },
        "provider_http_retry",
      );
      break;
    case "exhausted":
      // Only worth a log when a replay was actually declined or spent —
      // a plain 404 is the caller's business, not a transport incident.
      if (event.reason !== "client_error" && event.reason !== "nothing_to_retry") {
        logger.warn(
          {
            provider: event.label,
            url: event.url,
            attempts: event.attempts,
            reason: event.reason,
            status: event.status,
          },
          "provider_http_gave_up",
        );
      }
      break;
    case "poll_failed":
      logger.warn(
        {
          provider: event.label,
          url: event.url,
          status: event.status,
          errorMsg: event.error,
        },
        "poll_task_failed",
      );
      break;
    case "poll_timeout":
      logger.warn(
        { provider: event.label, url: event.url, maxWait: event.maxWaitMs },
        "poll_timeout",
      );
      break;
  }
}

/** What a provider call needs to state about itself. */
export interface ProviderRequestOptions {
  /** Vendor name, for telemetry. */
  provider: string;
  /**
   * Whether delivering this exact request a second time is free of side
   * effects — the caller's fact, not a preference.
   *
   * A generation submit is `false` unless the vendor accepts a client-side
   * idempotency key: a replay of an accepted-but-unacknowledged submit
   * bills a second generation upstream (the risk documented in the
   * 2026-07-07 retry-idempotency decision). Polls, reads and billing
   * lookups are `true`.
   */
  replaySafe: boolean;
  /** Per-attempt timeout, normally `resolved.timeout * 1000`. */
  timeoutMs: number;
}

/**
 * Make a JSON provider request, replaying only what the caller declared
 * safe to replay.
 * @param url - Request URL.
 * @param init - Fetch init (method, headers, body). Do not set `signal`
 *   here — each attempt is given its own deadline from `timeoutMs`.
 * @param options - Vendor name, replay-safety fact, per-attempt timeout.
 * @returns The parsed JSON response.
 * @throws {Error} On a non-ok final status (carrying the vendor's body) or
 *   a failure that produced no response.
 */
export async function requestWithRetry(
  url: string,
  init: RequestInit,
  options: ProviderRequestOptions,
): Promise<Record<string, unknown>> {
  return httpRequestJson(url, init, {
    replaySafe: options.replaySafe,
    timeoutMs: options.timeoutMs,
    onEvent: logTransportEvent,
    label: options.provider,
  });
}

/**
 * Like {@link requestWithRetry}, but hands back the response itself so the
 * caller decides how to read it.
 *
 * For the transports whose body is not JSON (ElevenLabs and Fish return
 * audio bytes) and for the ones that treat a non-ok status as a value rather
 * than an error (Topaz's cost estimate falls back to 0). Those callers were
 * previously on a bare `fetch` with no retry at all — not even for a 429.
 *
 * What comes back is body-guarded, not a raw `Response`: reading megabytes of
 * audio needs a deadline as much as waiting for the headers did, and a raw
 * response is exactly what let that deadline be skipped.
 * @param url - Request URL.
 * @param init - Fetch init (method, headers, body). Do not set `signal`
 *   here — each attempt is given its own deadline from `timeoutMs`.
 * @param options - Vendor name, replay-safety fact, header timeout.
 * @returns The final response, ok or not, with its body under a deadline.
 * @throws {Error} On a failure that produced no response at all.
 */
export async function requestRaw(
  url: string,
  init: RequestInit,
  options: ProviderRequestOptions,
): Promise<GuardedResponse> {
  return httpRequest(url, init, {
    replaySafe: options.replaySafe,
    timeoutMs: options.timeoutMs,
    onEvent: logTransportEvent,
    label: options.provider,
  });
}

/**
 * The 2s poll interval that seven transports carried before this transport
 * existed, restored verbatim.
 *
 * Nothing explains why those seven differ from the 3s default — no comment,
 * no commit message, no vendor documentation — and the split is not even
 * self-consistent: WaveSpeed's audio, image, speech, understanding and video
 * transports use 2s while its own 3D transport uses the default. Dropping
 * them during unification made five modalities poll 50% slower with no error
 * and no bug report, which is the kind of change that later gets mistaken
 * for the baseline.
 *
 * Restored rather than normalised on purpose: how fast we poll trades
 * perceived latency against vendor call volume, and that is a product call,
 * not something to settle inside a retry refactor. Whether these should
 * converge is tracked as its own question.
 */
export const INHERITED_POLL_INTERVAL_MS = 2000;

/** Worker-side poll options: vendor status vocabulary plus timing. */
export interface PollOptions {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  statusPath: string[];
  successStatuses: ReadonlySet<string>;
  failureStatuses: ReadonlySet<string>;
  errorPath?: string[];
  /** Wait between polls; defaults to `worker.yaml` `poll_interval`. */
  interval?: number;
  /** Total budget; defaults to `worker.yaml` `poll_max_wait`. */
  maxWait?: number;
  /** Per-poll request timeout, normally `resolved.timeout * 1000`. */
  timeoutMs: number;
  /** Vendor name, for telemetry and error messages. */
  provider?: string;
}

/**
 * Poll a vendor task endpoint until it reports a terminal status, with the
 * worker's configured timing as the default.
 * @param url - The task-status endpoint.
 * @param options - Vendor status vocabulary and timing overrides.
 * @returns The successful poll's response body.
 * @throws {Error} On a vendor failure status, an elapsed budget, or
 *   cancellation.
 */
export async function pollUntilDone(
  url: string,
  options: PollOptions,
): Promise<Record<string, unknown>> {
  const cfg = getWorkerConfig();
  return sharedPollUntilDone(url, {
    headers: options.headers,
    params: options.params,
    statusPath: options.statusPath,
    successStatuses: options.successStatuses,
    failureStatuses: options.failureStatuses,
    errorPath: options.errorPath,
    intervalMs: options.interval ?? cfg.poll_interval,
    maxWaitMs: options.maxWait ?? cfg.poll_max_wait,
    timeoutMs: options.timeoutMs,
    onEvent: logTransportEvent,
    label: options.provider ?? "provider",
  });
}

/**
 * Query the WaveSpeed billing API for a prediction's actual cost.
 *
 * Vendor-specific by nature — the path, the request field name and the
 * response shape are all WaveSpeed's contract — so it lives here as a
 * consumer of the transport rather than inside it.
 *
 * A failed lookup returns 0 rather than throwing: the generation itself
 * succeeded and must not be failed over an accounting query. The event is
 * logged so a persistently broken lookup is visible instead of silently
 * recording every generation as free.
 * @param resolved - The resolved provider endpoint and credentials.
 * @param taskId - The prediction UUID to price.
 * @returns The cost in USD, or 0 when the lookup failed.
 */
export async function queryBilling(
  resolved: ResolvedModel,
  taskId: string,
): Promise<number> {
  try {
    const data = await httpRequestJson(
      `${resolved.baseUrl}/billings/search`,
      {
        method: "POST",
        headers: bearerHeaders(resolved.apiKey),
        body: JSON.stringify({ prediction_uuids: [taskId] }),
      },
      {
        // A billing lookup only reads, so a flaky one is safe to replay.
        replaySafe: true,
        timeoutMs: getWorkerConfig().billing_timeout,
        onEvent: logTransportEvent,
        label: "wavespeed-billing",
      },
    );
    const price = extractNested(data, ["data", "0", "price"], 0);
    return typeof price === "number" ? price : 0;
  } catch (err) {
    logger.warn({ err, taskId }, "billing_query_failed");
    return 0;
  }
}
