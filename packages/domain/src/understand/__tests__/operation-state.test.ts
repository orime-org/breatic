// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { reduceUnderstandOperation } from "@domain/understand/operation-state.js";

const queued = { status: "queued" as const, revision: 0, deadlineAtMs: 2_000 };

describe("reduceUnderstandOperation", () => {
  it("claims and advances work only against the current revision", () => {
    expect(reduceUnderstandOperation(queued, {
      type: "claim", expectedRevision: 0, atMs: 1_000,
    })).toEqual({ ...queued, status: "running", revision: 1 });
    expect(() => reduceUnderstandOperation(queued, {
      type: "claim", expectedRevision: 2, atMs: 1_000,
    })).toThrow(RangeError);
  });

  it("keeps unknown paid outcomes blocked until an explicit retry decision", () => {
    const blocked = reduceUnderstandOperation({ ...queued, status: "running", revision: 1 }, {
      type: "unknown", expectedRevision: 1, atMs: 1_200,
    });
    expect(blocked.status).toBe("blocked");
    expect(() => reduceUnderstandOperation(blocked, {
      type: "advance", expectedRevision: 2, atMs: 1_250,
    })).toThrow(RangeError);
    expect(reduceUnderstandOperation(blocked, {
      type: "advance", expectedRevision: 2, atMs: 1_250, resolvesUnknown: true,
    })).toMatchObject({ status: "running", revision: 3 });
    expect(reduceUnderstandOperation(blocked, {
      type: "user-retry", expectedRevision: 2, atMs: 1_300, approved: true,
    })).toMatchObject({ status: "queued", revision: 3 });
    expect(() => reduceUnderstandOperation(blocked, {
      type: "user-retry", expectedRevision: 2, atMs: 1_300, approved: false,
    })).toThrow(RangeError);
  });

  it("requires full coverage for ready and preserves usable evidence as partial on failure", () => {
    const running = { ...queued, status: "running" as const, revision: 1 };
    expect(reduceUnderstandOperation(running, {
      type: "finish", expectedRevision: 1, atMs: 1_500, completeCoverage: false,
    })).toMatchObject({ status: "partial", revision: 2 });
    expect(reduceUnderstandOperation(running, {
      type: "finish", expectedRevision: 1, atMs: 1_500, completeCoverage: true,
    })).toMatchObject({ status: "ready", revision: 2 });
    expect(reduceUnderstandOperation(running, {
      type: "fatal", expectedRevision: 1, atMs: 1_500, hasUsableEvidence: true,
    })).toMatchObject({ status: "partial", revision: 2 });
  });

  it("makes terminal outcomes immutable and applies the original deadline", () => {
    const running = { ...queued, status: "running" as const, revision: 1 };
    const expired = reduceUnderstandOperation(running, {
      type: "deadline", expectedRevision: 1, atMs: 2_000,
    });
    expect(expired.status).toBe("expired");
    expect(() => reduceUnderstandOperation(running, {
      type: "finish", expectedRevision: 1, atMs: 2_000, completeCoverage: true,
    })).toThrow(RangeError);
    expect(reduceUnderstandOperation(expired, {
      type: "advance", expectedRevision: 2, atMs: 2_100,
    })).toEqual(expired);
  });
});
