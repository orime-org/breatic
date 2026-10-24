// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  sameNativeEditRecord,
  TimelinePersistenceRequestSchema,
  TimelinePersistenceResponseSchema,
} from "../persistence.js";

const clipId = "30000000-0000-4000-8000-000000000001";
const actionId = "40000000-0000-4000-8000-000000000001";
const secondActionId = "40000000-0000-4000-8000-000000000002";
const record = {
  version: 1 as const,
  actionId,
  operation: "set_start" as const,
  effect: "applied" as const,
  targetClipIds: [clipId],
  parameters: { clipId, startFrame: 24 },
};
const query = {
  version: 1 as const,
  id: "request-1",
  type: "timeline:persistence:query" as const,
  payload: { actionIds: [actionId] },
};
const response = {
  version: 1 as const,
  id: query.id,
  type: "timeline:persistence:result" as const,
  ok: true as const,
  result: { documentVersion: 1 as const, persistedRecords: [record], missingActionIds: [] },
};

describe("Timeline persistence request boundary", () => {
  it.each(["timeline:persistence:query", "timeline:persistence:retry"] as const)("accepts the %s namespace", (type) => {
    const value = { ...query, type };
    expect(TimelinePersistenceRequestSchema.parse(value)).toEqual(value);
  });

  it("permits an empty action batch for querying a persisted initial V1", () => {
    const value = { ...query, payload: { actionIds: [] } };
    expect(TimelinePersistenceRequestSchema.parse(value)).toEqual(value);
  });

  it("deduplicates action identifiers before the service processes the request", () => {
    const value = { ...query, payload: { actionIds: [actionId, secondActionId, actionId] } };
    expect(TimelinePersistenceRequestSchema.parse(value).payload.actionIds).toEqual([actionId, secondActionId]);
  });

  it.each([
    { version: 2 },
    { id: "" },
    { id: "r".repeat(65) },
    { type: "space:create" },
    { type: "timeline:persistence:store-any-document" },
    { projectId: "50000000-0000-4000-8000-000000000001" },
    { actorId: "60000000-0000-4000-8000-000000000001" },
  ])("rejects request shape %j", (changes) => {
    expect(TimelinePersistenceRequestSchema.safeParse({ ...query, ...changes }).success).toBe(false);
  });

  it.each([
    { actionIds: ["not-an-action-id"] },
    { actionIds: [actionId], docName: "another-document" },
    { actionIds: [actionId], projectId: "50000000-0000-4000-8000-000000000001" },
    { actionIds: [actionId], userId: "60000000-0000-4000-8000-000000000001" },
  ])("rejects payload %j because the connection supplies identity", (payload) => {
    expect(TimelinePersistenceRequestSchema.safeParse({ ...query, payload }).success).toBe(false);
  });

  it("bounds a wire batch to 128 unique actions", () => {
    const actionIds = Array.from({ length: 129 }, (_, index) => `40000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`);
    expect(TimelinePersistenceRequestSchema.parse({ ...query, payload: { actionIds: actionIds.slice(0, 128) } }).payload.actionIds).toHaveLength(128);
    expect(TimelinePersistenceRequestSchema.safeParse({ ...query, payload: { actionIds } }).success).toBe(false);
  });
});

describe("Timeline persistence result boundary", () => {
  it("carries the matching complete record and the actual document version", () => {
    expect(TimelinePersistenceResponseSchema.parse(response)).toEqual(response);
  });

  it("expresses a persisted V1 with no native edits without inventing an action", () => {
    const value = { ...response, result: { documentVersion: 1, persistedRecords: [], missingActionIds: [] } };
    expect(TimelinePersistenceResponseSchema.parse(value)).toEqual(value);
  });

  it.each(["stored", "refused", "deferred", "gone"] as const)("keeps attempt %s separate from missing action records", (attempt) => {
    const value = { ...response, result: { documentVersion: 1, persistedRecords: [], missingActionIds: [actionId], attempt } };
    expect(TimelinePersistenceResponseSchema.parse(value)).toEqual(value);
  });

  it.each(["FORBIDDEN", "NOT_FOUND", "INVALID_INPUT", "UNSUPPORTED_DOCUMENT", "INTERNAL"] as const)("accepts the %s error", (code) => {
    const value = { version: 1, id: query.id, type: "timeline:persistence:result", ok: false, error: { code, message: "Unavailable" } };
    expect(TimelinePersistenceResponseSchema.parse(value)).toEqual(value);
  });

  it.each([
    { documentVersion: 2 },
    { missingActionIds: ["invalid-id"] },
    { attempt: "saved" },
    { saved: true },
    { persistedRecords: [actionId] },
    { persistedRecords: [{ ...record, effect: "not_applied" }] },
    { persistedRecords: [{ ...record, vendorReceipt: "receipt" }] },
  ])("rejects an unsupported or incomplete result %j", (changes) => {
    expect(TimelinePersistenceResponseSchema.safeParse({ ...response, result: { ...response.result, ...changes } }).success).toBe(false);
  });

  it("accepts a saved not-applied fact with its original reason", () => {
    const notApplied = { ...record, effect: "not_applied", notAppliedReason: "target_missing" };
    const value = { ...response, result: { ...response.result, persistedRecords: [notApplied] } };
    expect(TimelinePersistenceResponseSchema.parse(value)).toEqual(value);
  });
});

describe("complete immutable edit comparison", () => {
  it("compares normalized DTO fields rather than object insertion order", () => {
    const reordered = {
      parameters: { startFrame: 24, clipId },
      targetClipIds: [clipId],
      effect: "applied" as const,
      operation: "set_start" as const,
      actionId,
      version: 1 as const,
    };
    expect(sameNativeEditRecord(record, reordered)).toBe(true);
  });

  it("does not confirm a different edit with the same action id", () => {
    expect(sameNativeEditRecord(record, { ...record, parameters: { clipId, startFrame: 25 } })).toBe(false);
    expect(sameNativeEditRecord(record, { ...record, actionId: secondActionId })).toBe(false);
    expect(sameNativeEditRecord(record, { ...record, effect: "not_applied", notAppliedReason: "target_missing" })).toBe(false);
  });

  it("does not lose the reason when comparing not-applied records", () => {
    const notApplied = { ...record, effect: "not_applied" as const, notAppliedReason: "target_missing" as const };
    expect(sameNativeEditRecord(notApplied, { ...notApplied })).toBe(true);
    expect(sameNativeEditRecord(notApplied, { ...notApplied, notAppliedReason: "source_unavailable" })).toBe(false);
  });

  it("compares every accepted source and clip parameter for an addition", () => {
    const source = {
      id: "10000000-0000-4000-8000-000000000001",
      kind: "video" as const,
      assetId: "20000000-0000-4000-8000-000000000001",
      timebase: { num: 24, den: 1 },
      extentFrames: 48,
      durationSeconds: "2",
      durationOrigin: "registered" as const,
    };
    const clip = {
      id: clipId,
      trackId: "visual-1",
      kind: "video" as const,
      sourceId: source.id,
      startFrame: 0,
      sourceInFrame: 0,
      durationFrames: 48,
      rate: { num: 1, den: 1 },
      gain: 1,
      mute: false,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    };
    const added = { ...record, operation: "add_video" as const, parameters: { source, clip } };
    expect(sameNativeEditRecord(added, { ...added, parameters: { clip: { ...clip }, source: { ...source } } })).toBe(true);
    expect(sameNativeEditRecord(added, { ...added, parameters: { source: { ...source, durationOrigin: "decoded" }, clip } })).toBe(false);
    expect(sameNativeEditRecord(added, { ...added, parameters: { source, clip: { ...clip, mute: true } } })).toBe(false);
  });

  it("is reflexive and detects a changed target frame for arbitrary valid edits", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 100000 }), (startFrame) => {
      const value = { ...record, parameters: { clipId, startFrame } };
      const before = structuredClone(value);
      expect(sameNativeEditRecord(value, structuredClone(value))).toBe(true);
      expect(sameNativeEditRecord(value, { ...value, parameters: { clipId, startFrame: startFrame + 1 } })).toBe(false);
      expect(value).toEqual(before);
    }));
  });
});
