// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { reduceUnderstandDispatch } from "@domain/understand/dispatch-state.js";

const pending = {
  status: "pending" as const,
  sequence: 4,
  revision: 7,
  dueAtMs: 1_000,
};

describe("reduceUnderstandDispatch", () => {
  it("sends one stable wake and makes duplicate dispatch idempotent", () => {
    const sent = reduceUnderstandDispatch(pending, {
      type: "dispatch", expectedRevision: 7, operationId: "op-1", atMs: 1_000,
    });

    expect(sent).toEqual({
      status: "sent", sequence: 4, revision: 8, dueAtMs: 1_000,
      jobId: "lm_op-1_4",
    });
    expect(reduceUnderstandDispatch(sent, {
      type: "dispatch", expectedRevision: 8, operationId: "op-1", atMs: 1_001,
    })).toEqual(sent);
  });

  it("claims a delivered wake once and retires stale sequences", () => {
    const claimed = reduceUnderstandDispatch({ ...pending, status: "sent" as const }, {
      type: "claim", expectedRevision: 7, wakeSequence: 4,
    });

    expect(claimed.status).toBe("claimed");
    expect(claimed.revision).toBe(8);
    expect(reduceUnderstandDispatch({ ...claimed, sequence: 5 }, {
      type: "claim", expectedRevision: 8, wakeSequence: 4,
    })).toEqual({ ...claimed, sequence: 5 });
  });

  it("requeues after a claimed step ends, while preserving sequence monotonicity", () => {
    const next = reduceUnderstandDispatch({
      ...pending, status: "claimed", sequence: 4, revision: 7, jobId: "lm_op-1_4",
    }, {
      type: "step-ended", expectedRevision: 7, nextDueAtMs: 2_000,
    });

    expect(next).toEqual({
      status: "pending", sequence: 5, revision: 8, dueAtMs: 2_000,
    });
  });

  it("retries failed delivery without changing its stable wake identity", () => {
    expect(reduceUnderstandDispatch({ ...pending, status: "sent", jobId: "lm_op-1_4" }, {
      type: "send-failure", expectedRevision: 7, retryAtMs: 3_000,
    })).toEqual({
      status: "pending", sequence: 4, revision: 8, dueAtMs: 3_000,
    });
  });

  it("records a retry time when a pending wake could not be sent", () => {
    expect(reduceUnderstandDispatch(pending, {
      type: "send-failure", expectedRevision: 7, retryAtMs: 3_000,
    })).toEqual({ ...pending, revision: 8, dueAtMs: 3_000 });
  });

  it("creates a new wake from a retired delivery after an approved open-operation handoff", () => {
    expect(reduceUnderstandDispatch({ ...pending, status: "retired" }, {
      type: "approved-handoff", expectedRevision: 7, nextDueAtMs: 4_000,
    })).toEqual({ status: "pending", sequence: 5, revision: 8, dueAtMs: 4_000 });
  });

  it("rejects stale writes and never creates work after a terminal operation", () => {
    expect(() => reduceUnderstandDispatch(pending, {
      type: "dispatch", expectedRevision: 6, operationId: "op-1", atMs: 1_000,
    })).toThrow(RangeError);
    expect(reduceUnderstandDispatch(pending, {
      type: "operation-ended", expectedRevision: 7,
    })).toMatchObject({ status: "retired", sequence: 4, revision: 8 });
  });
});
