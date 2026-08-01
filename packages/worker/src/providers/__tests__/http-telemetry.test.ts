// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one judgement in the worker's transport telemetry that is not obvious:
 * which refusals are worth a log line.
 *
 * It was written twice — once for the provider transports, once for the local
 * asset download — and neither copy had a test. Two copies of a rule is a rule
 * that drifts, and an untested one drifts silently.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@breatic/core", () => ({ logger: { warn, error: vi.fn(), info: vi.fn() } }));

import { httpEventLogger } from "@worker/providers/http-telemetry.js";

const log = httpEventLogger({ retry: "probe_retry", gaveUp: "probe_gave_up" });

/**
 * Build an exhaustion event with the given refusal reason.
 * @param reason - Why the transport stopped.
 * @param extra - Extra fields to merge in.
 * @returns The event.
 */
function exhausted(
  reason: string,
  extra: Record<string, unknown> = {},
): Parameters<typeof log>[0] {
  return {
    type: "exhausted",
    label: "vendor",
    url: "https://vendor.test/x",
    attempts: 3,
    reason,
    ...extra,
  } as Parameters<typeof log>[0];
}

describe("worker transport telemetry", () => {
  beforeEach(() => {
    warn.mockReset();
  });

  it("logs every replay, under the caller's own event name", () => {
    log({
      type: "retry",
      label: "vendor",
      url: "https://vendor.test/x",
      attempt: 1,
      delayMs: 500,
      reason: "server_error",
      status: 503,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBe("probe_retry");
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, delay: 500, status: 503 });
  });

  it.each(["client_error", "nothing_to_retry"])(
    "stays quiet about a %s refusal",
    (reason) => {
      // A plain 404, or a request nobody ever intended to replay, is the
      // caller's business. Logging those buries the ones that matter.
      log(exhausted(reason, { status: 404 }));

      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each(["retries_exhausted", "not_replay_safe", "retry_after_too_long", "caller_aborted"])(
    "reports a %s refusal",
    (reason) => {
      log(exhausted(reason));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toBe("probe_gave_up");
    },
  );

  it("carries the wait the server named, when that is why we refused", () => {
    // The figure exists only on this refusal and it is the one thing an
    // engineer cannot recover from the rest of the line.
    log(exhausted("retry_after_too_long", { status: 429, retryAfterMs: 45_000 }));

    expect(warn.mock.calls[0]?.[0]).toMatchObject({ retryAfterMs: 45_000 });
  });

  it("omits the figure entirely when there was none", () => {
    log(exhausted("retries_exhausted", { status: 503 }));

    expect(warn.mock.calls[0]?.[0]).not.toHaveProperty("retryAfterMs");
  });
});
