// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { miniToolExecutionRecordSchema, type MiniToolExecutionRecord } from "@shared/mini-tools/execution-record.js";

const RUN = "50000000-0000-4000-8000-000000000001";
const NODE = "40000000-0000-4000-8000-000000000001";
const BINDING = { assetId: "80000000-0000-4000-8000-000000000001", contentHash: "a".repeat(64), canonicalURL: "https://assets.example.test/video/source.mp4", kind: "video" as const,
  mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: "video/mp4" } };
const MEDIA = { status: "registered" as const, assetId: "90000000-0000-4000-8000-000000000001", canonicalURL: "https://assets.example.test/video/winner.webm", kind: "video" as const,
  contentHash: "147d7b46f5062b1cc7231edff71bed11071dd088c5b3434432f24e5d41037a07", mimeType: "video/webm", size: 1588436, width: 960, height: 540, duration: 5.013, cover: null };
const KEY = "b".repeat(64);
/** Construct only the independently frozen public wire fixture. */
function record(): MiniToolExecutionRecord {
  return { schemaVersion: 1, runId: RUN, status: "pending", planFingerprint: "c".repeat(64), resultVersion: 0, sourceBindings: [structuredClone(BINDING)],
    outputs: [{ outputIndex: 0, nodeId: NODE, recipe: { kind: "segment", range: { start: 0, end: 30 } }, result: null }], usage: [], billingState: "idle", error: null };
}
/** Construct the initial complete media snapshot, independently of the schema. */
function done(): MiniToolExecutionRecord {
  const r = record(); r.status = "completed"; r.resultVersion = 1; r.outputs[0]!.result = structuredClone(MEDIA); return r;
}

describe("planned execution public record (independent lifecycle oracle M/U/B)", () => {
  it.each(["pending", "running"] as const)("M01/B01 retains the complete active %s slots and source", (status) => {
    const r = record(); r.status = status; expect(miniToolExecutionRecordSchema.parse(r)).toEqual(r);
  });
  it("M02 preserves input 5.055 separately from actual registered 5.013", () => {
    const r = done(); const before = structuredClone(r); expect(miniToolExecutionRecordSchema.parse(r)).toEqual(r);
    expect(r.sourceBindings[0]!.mediaInfo.duration).toBe(5.055); expect(r.outputs[0]!.result).toEqual(MEDIA); expect(r).toEqual(before);
  });
  it("M02 accepts a live registered image cover with nullable measured geometry", () => {
    const r = done(); r.outputs[0]!.result = { ...MEDIA, cover: { assetId: "91000000-0000-4000-8000-000000000001", canonicalURL: "https://assets.example.test/image/cover.png", kind: "image", mimeType: "image/png", size: 128, contentHash: "d".repeat(64), width: null, height: 54 } };
    expect(miniToolExecutionRecordSchema.parse(r)).toEqual(r);
  });
  it("M02 preserves unmeasured media values as null", () => {
    const r = done(); r.outputs[0]!.result = { ...MEDIA, width: null, height: null, duration: null }; expect(miniToolExecutionRecordSchema.parse(r)).toEqual(r);
  });
  // frames-split §7.19: a run is one whole, so a failed run holds no registered output and nothing is delivered late.
  it("M06 rejects a failed record that still holds a registered output", () => {
    const r = done(); r.status = "failed"; r.error = { code: "registration_failed" }; r.resultVersion = 2;
    expect(miniToolExecutionRecordSchema.safeParse(r).success).toBe(false);
  });
  it("M06 retains failed status and its first error on every output", () => {
    const r = record(); r.status = "failed"; r.resultVersion = 1; r.error = { code: "mini_tool_failed", message: "over_cap" };
    r.outputs[0]!.result = { status: "failed", error: { code: "mini_tool_failed", message: "over_cap" } };
    expect(miniToolExecutionRecordSchema.parse(r)).toEqual(r);
  });
  it.each(["late", "takenOver"])("M13 rejects the retired per-output %s flag", (key) => {
    const r = done(); expect(miniToolExecutionRecordSchema.safeParse({ ...r, outputs: [{ ...r.outputs[0], [key]: false }] }).success).toBe(false);
  });
  // frames-split §7.19 提交点: a running record past its commit point carries when it was written; its outputs are
  // registered only by the one completed commit.
  it("M14 accepts a running record past its commit point with no output result", () => {
    const r = record(); r.status = "running"; r.commitPoint = "2026-11-24T08:00:00.000Z";
    expect(miniToolExecutionRecordSchema.parse(r)).toEqual(r);
  });
  it.each(["pending", "completed", "failed", "cancelled"] as const)("M14 rejects a commit point on a %s record", (status) => {
    const r = status === "completed" ? done() : record(); r.status = status;
    if (status === "failed") { r.resultVersion = 1; r.error = { code: "internal" }; r.outputs[0]!.result = { status: "failed", error: { code: "internal" } }; }
    expect(miniToolExecutionRecordSchema.safeParse({ ...r, commitPoint: "2026-11-24T08:00:00.000Z" }).success).toBe(false);
  });
  it("M14 rejects a commit point that is not an instant", () => {
    const r = record(); r.status = "running"; expect(miniToolExecutionRecordSchema.safeParse({ ...r, commitPoint: "soon" }).success).toBe(false);
  });
  it("M15 rejects a running record holding a registered output, whatever its version", () => {
    const r = record(); r.status = "running"; r.resultVersion = 1; r.outputs[0]!.result = structuredClone(MEDIA);
    expect(miniToolExecutionRecordSchema.safeParse(r).success).toBe(false);
  });
  it("M12 retains cancelled rather than mapping it to analysis failed", () => {
    const r = record(); r.status = "cancelled"; expect(miniToolExecutionRecordSchema.parse(r)).toEqual(r);
  });
  it("M01 terminal failure retains the original indexed recipe", () => {
    const r = record(); r.status = "failed"; r.resultVersion = 1; r.error = { code: "expired" }; r.outputs[0]!.result = { status: "failed", error: { code: "expired" } };
    expect(miniToolExecutionRecordSchema.parse(r)).toEqual(r);
  });
  it.each([
    { state: "pending", chargeTo: "user", costUsd: null, credits: null },
    { state: "known", chargeTo: "user", costUsd: 0.3, credits: null },
    { state: "recorded", chargeTo: "user", costUsd: 0.3, credits: 30 },
    { state: "known", chargeTo: "platform", costUsd: 0.3, credits: null },
    { state: "recorded", chargeTo: "platform", costUsd: 0.3, credits: 0 },
  ] as const)("U permits $state/$chargeTo without changing media version", (usage) => {
    const r = done(); r.usage = [{ consumptionKey: KEY, ...usage }]; r.billingState = "waiting";
    expect(miniToolExecutionRecordSchema.parse(r)).toEqual(r); expect(r.resultVersion).toBe(1);
  });
  it.each(["idle", "waiting", "checking", "settled"] as const)("B03 preserves actual %s instead of deriving from media", (billingState) => {
    const r = done(); r.billingState = billingState; expect(miniToolExecutionRecordSchema.parse(r)).toEqual(r);
  });
  it.each([
    { state: "pending", costUsd: 0.3, credits: null }, { state: "pending", costUsd: null, credits: 0 },
    { state: "known", costUsd: null, credits: null }, { state: "known", costUsd: 0.3, credits: 30 },
    { state: "recorded", costUsd: 0.3, credits: null }, { state: "recorded", costUsd: null, credits: 0 },
  ])("U rejects an illegal amount/null state $state/$costUsd/$credits", (usage) => {
    const r = done(); r.usage = [{ consumptionKey: KEY, chargeTo: "user", ...usage } as MiniToolExecutionRecord["usage"][number]];
    expect(miniToolExecutionRecordSchema.safeParse(r).success).toBe(false);
  });
  it("U07 rejects nonzero platform credits", () => {
    const r = done(); r.usage = [{ consumptionKey: KEY, state: "recorded", chargeTo: "platform", costUsd: 0.3, credits: 30 }]; expect(miniToolExecutionRecordSchema.safeParse(r).success).toBe(false);
  });
  it("U01 rejects duplicate public consumption keys", () => {
    const r = done(); const u = { consumptionKey: KEY, state: "pending" as const, chargeTo: "user" as const, costUsd: null, credits: null }; r.usage = [u, u];
    expect(miniToolExecutionRecordSchema.safeParse(r).success).toBe(false);
  });
  it.each(["sourceKey", "body", "providerURL", "raw", "credentials"])("Q10 rejects private top-level %s", (key) => {
    expect(miniToolExecutionRecordSchema.safeParse({ ...done(), [key]: "private" }).success).toBe(false);
  });
  it.each(["raw", "identity", "creditMultiplier", "containerPricing"])("Q10 rejects private usage %s", (key) => {
    const r = done(); expect(miniToolExecutionRecordSchema.safeParse({ ...r, usage: [{ consumptionKey: KEY, state: "known", chargeTo: "user", costUsd: 0.3, credits: null, [key]: {} }] }).success).toBe(false);
  });
  it.each(["sourceKey", "providerURL", "packedURL"])("Q10 rejects private registered %s", (key) => {
    const r = done(); expect(miniToolExecutionRecordSchema.safeParse({ ...r, outputs: [{ ...r.outputs[0], result: { ...MEDIA, [key]: "private" } }] }).success).toBe(false);
  });
  it.each(["empty", "duplicate", "active media", "terminal null", "completed failed slot", "negative index", "bad hash"])("M rejects malformed snapshot %s", (bad) => {
    const r = bad === "active media" ? record() : done();
    if (bad === "empty") r.outputs = [];
    else if (bad === "duplicate") r.outputs.push(structuredClone(r.outputs[0]!));
    else if (bad === "active media") r.outputs[0]!.result = structuredClone(MEDIA);
    else if (bad === "terminal null") r.outputs[0]!.result = null;
    else if (bad === "completed failed slot") r.outputs[0]!.result = { status: "failed", error: { code: "expired" } };
    else if (bad === "negative index") r.outputs[0]!.outputIndex = -1;
    else r.planFingerprint = "invalid";
    expect(miniToolExecutionRecordSchema.safeParse(r).success).toBe(false);
  });
  it("M03/U keeps media identity invariant under finite recorded amount changes", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 10000 }), (cents) => {
      const r = done(); r.usage = [{ consumptionKey: KEY, state: "recorded", chargeTo: "user", costUsd: cents / 100, credits: cents }];
      const parsed = miniToolExecutionRecordSchema.parse(r); expect(parsed.outputs).toEqual(done().outputs); expect(parsed.resultVersion).toBe(1);
    }));
  });
});
