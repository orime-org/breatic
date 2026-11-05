// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `doc:size` push contract between collab and web, and the constants both
 * ends share (inner#1790, spec C-01 to C-06, C-08, C-09).
 */

import { describe, expect, it } from "vitest";
import * as barrel from "@shared/index.js";
import { DOC_SIZE_EVENT_BYTES, DocSizeStatusSchema, SPACE_DELETE_MIN_BYTES } from "@shared/doc-size.js";
import { COLLAB_DOCUMENT_TOO_LARGE_REASON } from "@shared/collab-close-reasons.js";

/** The first valid push of C-01, the base the other cases vary. */
const BASE = {
  type: "doc:size",
  bytes: 0,
  limit: 10485760,
  ceiling: 10747904,
  room: 10223616,
  overwriteRoom: 10682368,
  phase: "normal",
} as const;

const NUMBER_FIELDS = ["bytes", "limit", "ceiling", "room", "overwriteRoom"] as const;
const ALL_KEYS = ["type", "bytes", "limit", "ceiling", "room", "overwriteRoom", "phase"] as const;

describe("DocSizeStatusSchema", () => {
  it("C-01 accepts zero, a push over the ceiling and the largest safe integer, unchanged", () => {
    const inputs = [
      BASE,
      { ...BASE, bytes: 10747905, room: 0, overwriteRoom: 0, phase: "full" },
      { ...BASE, bytes: Number.MAX_SAFE_INTEGER },
    ];
    for (const input of inputs) {
      const result = DocSizeStatusSchema.safeParse(input);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(input);
    }
  });

  it("C-02 refuses a negative, fractional, string or NaN value in every numeric field", () => {
    for (const field of NUMBER_FIELDS) {
      for (const bad of [-1, 0.5, "5", Number.NaN]) {
        const result = DocSizeStatusSchema.safeParse({ ...BASE, [field]: bad });
        expect(result.success, `${field} = ${String(bad)}`).toBe(false);
        expect(result.error?.issues[0]?.path, `${field} = ${String(bad)}`).toEqual([field]);
      }
    }
  });

  it("C-03 refuses a push missing any one of its seven keys", () => {
    for (const key of ALL_KEYS) {
      const input: Record<string, unknown> = { ...BASE };
      delete input[key];
      const result = DocSizeStatusSchema.safeParse(input);
      expect(result.success, key).toBe(false);
      expect(result.error?.issues[0]?.path, key).toEqual([key]);
    }
  });

  it("C-04 knows only the server phases and the doc:size type", () => {
    for (const phase of ["normal", "warning", "full"]) {
      expect(DocSizeStatusSchema.safeParse({ ...BASE, phase }).success, phase).toBe(true);
    }
    // `unknown` and `resyncing` are web-only states; collab never sends them.
    for (const phase of ["unknown", "resyncing", "", "FULL"]) {
      expect(DocSizeStatusSchema.safeParse({ ...BASE, phase }).success, phase).toBe(false);
    }
    for (const type of ["doc:sized", "sync:confirmed"]) {
      expect(DocSizeStatusSchema.safeParse({ ...BASE, type }).success, type).toBe(false);
    }
  });

  it("C-05 accepts the no-limit shape and does not force its other values to zero", () => {
    const unlimited = { type: "doc:size", bytes: 0, limit: 0, ceiling: 0, room: 0, overwriteRoom: 0, phase: "normal" };
    expect(DocSizeStatusSchema.safeParse(unlimited).success).toBe(true);
    expect(DocSizeStatusSchema.safeParse({ ...unlimited, bytes: 5, ceiling: 7 }).success).toBe(true);
  });

  it("C-09 accepts a push carrying an extra key, so a newer server does not break an older client", () => {
    expect(DocSizeStatusSchema.safeParse({ ...BASE, extra: 1 }).success).toBe(true);
  });
});

describe("shared size constants", () => {
  it("C-06 derives the delete minimum from the per-event constant", () => {
    expect(SPACE_DELETE_MIN_BYTES).toBe(2 * DOC_SIZE_EVENT_BYTES + 16);
    expect(Number.isInteger(SPACE_DELETE_MIN_BYTES)).toBe(true);
    expect(Number.isInteger(DOC_SIZE_EVENT_BYTES)).toBe(true);
    expect(DOC_SIZE_EVENT_BYTES).toBeGreaterThan(0);
  });
});

describe("the shared main entry", () => {
  it("C-08 re-exports the size contract and the close reason from src/index.ts", () => {
    expect(barrel.DocSizeStatusSchema).toBe(DocSizeStatusSchema);
    expect(barrel.SPACE_DELETE_MIN_BYTES).toBe(SPACE_DELETE_MIN_BYTES);
    expect(barrel.COLLAB_DOCUMENT_TOO_LARGE_REASON).toBe(COLLAB_DOCUMENT_TOO_LARGE_REASON);
    expect(barrel.DOC_SIZE_EVENT_BYTES).toBe(DOC_SIZE_EVENT_BYTES);
  });
});
