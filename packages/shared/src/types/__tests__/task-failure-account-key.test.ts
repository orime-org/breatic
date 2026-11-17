// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The failures a run on an account's own upstream key ends with (inner#1953), stored as codes each viewer reads in
 * their own language: the key failed at its upstream (and why), the key the task holds the id of was replaced or
 * deleted, or the upstream could not be reached. Each names the upstream it is about, so the sentence can say which
 * one to top up or which key to change.
 */

import { describe, expect, it } from "vitest";

import { encodeTaskFailure, readTaskFailure, TASK_FAILURE_REASONS, type TaskFailureDetail } from "@shared/types/task-failure.js";

describe("the causes a run on an account's key can fail on", () => {
  it("are causes of their own", () => {
    expect(TASK_FAILURE_REASONS).toEqual(expect.arrayContaining(["account_key_failed", "account_key_missing", "upstream_unavailable"]));
  });

  it.each(["invalid", "no_balance", "model_not_found", "rate_limited"] as const)(
    "carries the upstream and why its key failed (%s) back out",
    (keyReason) => {
      const about = { model: "Seedream 5", upstream: "fal", keyReason } as unknown as TaskFailureDetail;
      expect(readTaskFailure(encodeTaskFailure("account_key_failed" as never, about))).toEqual({
        reason: "account_key_failed",
        model: "Seedream 5",
        upstream: "fal",
        keyReason,
      });
    },
  );

  it("drops a key failure reason that is not one of ours", () => {
    const stored = JSON.stringify({ reason: "account_key_failed", upstream: "fal", keyReason: "sk-or-v1-secret" });
    const read = readTaskFailure(stored) as Record<string, unknown>;
    expect(read.reason).toBe("account_key_failed");
    expect(read).not.toHaveProperty("keyReason");
  });

  it("names a replaced or deleted key, and an unreachable upstream, by the upstream", () => {
    expect(readTaskFailure(encodeTaskFailure("account_key_missing" as never, { upstream: "openrouter" } as unknown as TaskFailureDetail))).toEqual({
      reason: "account_key_missing",
      upstream: "openrouter",
    });
    expect(readTaskFailure(encodeTaskFailure("upstream_unavailable" as never, { upstream: "sandbase" } as unknown as TaskFailureDetail))).toEqual({
      reason: "upstream_unavailable",
      upstream: "sandbase",
    });
  });
});
