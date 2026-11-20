// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

type AnalysisKind = "scene_cuts";
type ObjectValue = Record<string, unknown>;

interface AnalysisRecord {
  schemaVersion: 1;
  draftId: string;
  revision: string;
  kind: AnalysisKind;
  analysisRunId: string;
  acceptedAt: string;
  status: "pending" | "running" | "completed" | "failed";
  binding: ObjectValue;
  analysisInput: ObjectValue;
  inputFingerprint: string;
  result: ObjectValue | null;
  error: ObjectValue | null;
  usage: ObjectValue[];
  artifactUnavailable: boolean;
}

interface AnalysisInputSource {
  kind: AnalysisKind;
  source: { nodeId: string; canonicalURL: string };
  params: ObjectValue;
  profile: ObjectValue;
  draftId?: string;
  revision?: string;
  runId?: string;
  currentProfile?: ObjectValue;
}

interface AnalysisApi {
  miniToolAnalysisRecordSchema: {
    parse: (input: unknown) => AnalysisRecord;
    safeParse: (input: unknown) => { success: boolean };
  };
  projectMiniToolAnalysisInput: (input: AnalysisInputSource) => ObjectValue;
  fingerprintMiniToolAnalysisInput: (input: ObjectValue) => string | Promise<string>;
  selectMiniToolAnalyses: (
    records: readonly unknown[],
    query: { draftId: string; kind: AnalysisKind; inputFingerprint: string; references?: readonly unknown[] },
  ) => { latestAccepted: AnalysisRecord | null; latestSuccessful: AnalysisRecord | null };
}

// Namespace access keeps collection working before the new public API exists.
const api = miniTools as unknown as AnalysisApi;
const kinds: AnalysisKind[] = ["scene_cuts"];
const earlyId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const laterId = "00000000-0000-4000-8000-000000000002";
const failedId = "00000000-0000-4000-8000-000000000003";
const earlyTime = "2026-10-24T09:03:03.000001Z";
const laterTime = "2026-10-24T09:03:03.000002Z";
const revision = "40000000-0000-4000-8000-000000000001";
const nextRevision = "40000000-0000-4000-8000-000000000002";
const otherDraftId = "20000000-0000-4000-8000-000000000002";
const profile = {
  id: "detector-v1",
  version: "1.2.3",
  weightsHash: null,
  params: { threshold: 0.4, sampling: { everyNthFrame: 2, maxSide: 960 } },
};
const binding = {
  assetId: "10000000-0000-4000-8000-000000000001",
  contentHash: "a".repeat(64),
  canonicalURL: "https://media.example.test/source.mp4",
  kind: "video",
  mediaInfo: { width: 960, height: 540, duration: 5, mimeType: "video/mp4" },
};

/** Builds the externally specified dependency fixture. @throws {Error} Never. */
function inputFor(kind: AnalysisKind): AnalysisInputSource {
  return {
    kind,
    source: { nodeId: "50000000-0000-4000-8000-000000000001", canonicalURL: binding.canonicalURL },
    profile: structuredClone(profile),
    params: {
      anchor: { frameIndex: 3 },
      range: { start: 0, end: 5 },
      region: { box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, points: [{ x: 0.2, y: 0.3, label: "positive" }] },
      trackingPrompt: "the person on the left",
      dialogues: [{ dialogueId: "row-a", personId: "person-a", audioNodeId: "audio-a", startTime: 0 }],
      cuts: [1, 2],
      clips: [{ id: "clip-a", in: 0, out: 2 }],
      erasePrompt: "remove the person",
      quality: "high",
      encoding: "h264",
      syncMode: "cut_off",
    },
  };
}

/** States the complete dependency projection, independently of its implementation. @throws {Error} Never. */
function expectedInput(kind: AnalysisKind): ObjectValue {
  return { schemaVersion: 1, kind, sourceURL: binding.canonicalURL, profile: structuredClone(profile), range: { start: 0, end: 5 } };
}

/** Builds a frozen common record and its matching typed result. @throws {Error} Never. */
function recordFor(kind: AnalysisKind, analysisRunId = earlyId, acceptedAt = earlyTime): AnalysisRecord {
  const identity = {
    schemaVersion: 1 as const,
    draftId: "20000000-0000-4000-8000-000000000001",
    revision,
    kind,
    analysisRunId,
    acceptedAt,
    binding: structuredClone(binding),
    analysisInput: expectedInput(kind),
    inputFingerprint: "b".repeat(64),
  };
  const data: ObjectValue = { fps: { numerator: 25, denominator: 1 }, frameCount: 125, cuts: [] };
  return { ...identity, status: "completed", result: { ...structuredClone(identity), ...data }, error: null, usage: [], artifactUnavailable: false };
}

/** Extracts only the two run identities asserted by the independent selection oracle. @throws {Error} Never. */
function selectedIds(kind: AnalysisKind, records: unknown[]): { latestAccepted: string | null; latestSuccessful: string | null } {
  const selected = api.selectMiniToolAnalyses(records, { draftId: recordFor(kind).draftId, kind, inputFingerprint: "b".repeat(64) });
  return { latestAccepted: selected.latestAccepted?.analysisRunId ?? null, latestSuccessful: selected.latestSuccessful?.analysisRunId ?? null };
}

describe("batch six analysis public contract", () => {
  it("exports the analysis entry points before behavioral assertions run", () => {
    expect(["miniToolAnalysisRecordSchema", "projectMiniToolAnalysisInput", "fingerprintMiniToolAnalysisInput", "selectMiniToolAnalyses"].filter((key) => !(key in miniTools))).toEqual([]);
  });

  describe.each(kinds)("%s common record schema", (kind) => {
    it("preserves the six-digit UTC acceptance time and frozen draft echo", () => {
      const record = recordFor(kind);
      expect(api.miniToolAnalysisRecordSchema.parse(record)).toEqual(record);
    });

    it.each(["draftId", "revision", "kind", "analysisRunId", "acceptedAt", "status", "binding", "analysisInput", "inputFingerprint", "result", "error", "usage"])("requires common record field %s", (field) => {
      const incomplete: ObjectValue = { ...recordFor(kind) };
      delete incomplete[field];
      expect(api.miniToolAnalysisRecordSchema.safeParse(incomplete).success).toBe(false);
    });

    it.each([undefined, "2026-02-30T09:03:03.000001Z", "2026-10-24T09:03:03.000001+00:00", "2026-10-24T09:03:03.001Z", "2026-10-24T09:03:03.0000001Z"])("rejects invalid acceptance time %s", (acceptedAt) => {
      const record = recordFor(kind);
      expect(api.miniToolAnalysisRecordSchema.safeParse({ ...record, acceptedAt, result: { ...record.result, acceptedAt } }).success).toBe(false);
    });

    it.each(["draftId", "revision", "analysisRunId"])("requires UUID identity field %s", (field) => {
      const record = recordFor(kind);
      expect(api.miniToolAnalysisRecordSchema.safeParse({ ...record, [field]: "invalid-identity", result: { ...record.result, [field]: "invalid-identity" } }).success).toBe(false);
    });

    it.each(["analysisRunId", "acceptedAt", "binding", "draftId", "revision", "kind", "inputFingerprint", "analysisInput"])("rejects mismatching result %s", (field) => {
      const record = recordFor(kind);
      const replacement: ObjectValue = { analysisRunId: laterId, acceptedAt: laterTime, binding: { ...binding, contentHash: "d".repeat(64) }, draftId: otherDraftId, revision: nextRevision, kind: kinds.find((candidate) => candidate !== kind), inputFingerprint: "d".repeat(64), analysisInput: { ...record.analysisInput, sourceURL: "https://media.example.test/other.mp4" } };
      expect(api.miniToolAnalysisRecordSchema.safeParse({ ...record, result: { ...record.result, [field]: replacement[field] } }).success).toBe(false);
    });

    it("accepts pending with no result or error", () => {
      const pending = { ...recordFor(kind), status: "pending" as const, result: null, error: null };
      expect(api.miniToolAnalysisRecordSchema.parse(pending)).toEqual(pending);
    });

    it("preserves a failed terminal status with an identity-matching late typed result", () => {
      const failed = { ...recordFor(kind), status: "failed" as const, error: { code: "analysis_failed" } };
      expect(api.miniToolAnalysisRecordSchema.parse(failed)).toEqual(failed);
      expect(selectedIds(kind, [failed])).toEqual({ latestAccepted: earlyId, latestSuccessful: null });
    });

    it("rejects binding URL changes that disagree with the frozen source URL", () => {
      const record = recordFor(kind);
      const changedBinding = { ...binding, canonicalURL: "https://media.example.test/other.mp4" };
      expect(api.miniToolAnalysisRecordSchema.safeParse({ ...record, binding: changedBinding, result: { ...record.result, binding: changedBinding } }).success).toBe(false);
    });

    it("rejects frozen source URL changes that disagree with the binding URL", () => {
      const record = recordFor(kind);
      const analysisInput = { ...record.analysisInput, sourceURL: "https://media.example.test/other.mp4" };
      expect(api.miniToolAnalysisRecordSchema.safeParse({ ...record, analysisInput, result: { ...record.result, analysisInput } }).success).toBe(false);
    });
  });

  describe.each(kinds)("%s stable analysis selection", (kind) => {
    it("orders microseconds before UUID and keeps the earlier successful result", () => {
      const early = recordFor(kind);
      const running = { ...recordFor(kind, laterId, laterTime), status: "running" as const, result: null };
      const failed = { ...recordFor(kind, failedId, laterTime), status: "failed" as const, result: null, error: { code: "analysis_failed" } };
      expect(selectedIds(kind, [early, running])).toEqual({ latestAccepted: laterId, latestSuccessful: earlyId });
      expect(selectedIds(kind, [early, running, failed])).toEqual({ latestAccepted: failedId, latestSuccessful: earlyId });
      expect(selectedIds(kind, [early, recordFor(kind, laterId, laterTime), failed])).toEqual({ latestAccepted: failedId, latestSuccessful: laterId });
    });

    it("ignores another draft, kind or fingerprint without treating revision as a dependency", () => {
      const early = recordFor(kind);
      const newer = recordFor(kind, laterId, laterTime);
      const otherDraft = { ...newer, draftId: otherDraftId, result: { ...newer.result, draftId: otherDraftId } };
      const otherInput = { ...newer, inputFingerprint: "d".repeat(64), result: { ...newer.result, inputFingerprint: "d".repeat(64) } };
      expect(selectedIds(kind, [early, otherDraft, { ...newer, kind: "people", result: { ...newer.result, kind: "people" } }, otherInput])).toEqual({ latestAccepted: earlyId, latestSuccessful: earlyId });
      expect(selectedIds(kind, [{ ...newer, revision: nextRevision, result: { ...newer.result, revision: nextRevision } }])).toEqual({ latestAccepted: laterId, latestSuccessful: laterId });
      expect(selectedIds(kind, [])).toEqual({ latestAccepted: null, latestSuccessful: null });
      expect(selectedIds(kind, [otherInput])).toEqual({ latestAccepted: null, latestSuccessful: null });
    });

    it("keeps unavailable artifacts out of successful reuse without adding an execution status", () => {
      const unavailable = { ...recordFor(kind, laterId, laterTime), artifactUnavailable: true };
      expect(api.miniToolAnalysisRecordSchema.parse(unavailable).status).toBe("completed");
      expect(selectedIds(kind, [recordFor(kind), unavailable])).toEqual({ latestAccepted: laterId, latestSuccessful: earlyId });
    });

    it("returns the same exact run identities for every response ordering", () => {
      const records = [recordFor(kind), { ...recordFor(kind, laterId, laterTime), status: "running" as const, result: null }, { ...recordFor(kind, failedId, laterTime), status: "failed" as const, result: null, error: { code: "analysis_failed" } }];
      fc.assert(fc.property(fc.shuffledSubarray(records, { minLength: 3, maxLength: 3 }), (permutation) => {
        expect(selectedIds(kind, permutation)).toEqual({ latestAccepted: failedId, latestSuccessful: earlyId });
      }));
    });

    it("includes valid pending records in the latest accepted progress", () => {
      const pending = { ...recordFor(kind, laterId, laterTime), status: "pending" as const, result: null, error: null };
      expect(selectedIds(kind, [recordFor(kind), pending])).toEqual({ latestAccepted: laterId, latestSuccessful: earlyId });
    });

    it("keeps a failed late result out of successful reuse", () => {
      const failed = { ...recordFor(kind, laterId, laterTime), status: "failed" as const, error: { code: "analysis_failed" } };
      expect(selectedIds(kind, [recordFor(kind), failed])).toEqual({ latestAccepted: laterId, latestSuccessful: earlyId });
    });

    it("skips malformed records in either ordering and when repeated", () => {
      const newer = recordFor(kind, laterId, laterTime);
      const missingTime: ObjectValue = { ...newer };
      delete missingTime.acceptedAt;
      const malformed: unknown[] = [
        null, undefined, [], {}, missingTime,
        { ...newer, result: null },
        { ...newer, schemaVersion: 2 },
        { ...newer, kind: "unknown-analysis" },
        { ...newer, result: { ...newer.result, acceptedAt: "not-a-timestamp" } },
        { ...newer, result: { ...newer.result, analysisRunId: failedId } },
      ];
      const early = recordFor(kind);
      const expected = { latestAccepted: earlyId, latestSuccessful: earlyId };
      expect(selectedIds(kind, [...malformed, early])).toEqual(expected);
      expect(selectedIds(kind, [early, ...[...malformed].reverse()])).toEqual(expected);
      expect(selectedIds(kind, [...malformed, early, ...malformed])).toEqual(expected);
    });
  });

  describe("nonempty typed analysis results", () => {
    it("preserves the independently specified nonempty scene cuts", () => {
      const record = recordFor("scene_cuts");
      const nonempty = { ...record, result: { ...record.result, cuts: [{ frameIndex: 25, detectionScore: 0.7 }, { frameIndex: 75, detectionScore: 0.8 }] } };
      expect(api.miniToolAnalysisRecordSchema.parse(nonempty)).toEqual(nonempty);
    });

    it("rejects a cut whose index equals the total frame count", () => {
      const record = recordFor("scene_cuts");
      expect(api.miniToolAnalysisRecordSchema.safeParse({ ...record, result: { ...record.result, cuts: [{ frameIndex: 125, detectionScore: 0.7 }] } }).success).toBe(false);
    });

  });

  it.each([
    ["scene_cuts", "2d9dfe5d020cba42028e4112bb584093bcf0032361a29ae6533ded981fffdbb8"],
  ] as const)("matches the independent version-one %s fingerprint golden value", async (kind, expected) => {
    expect(await api.fingerprintMiniToolAnalysisInput(expectedInput(kind))).toBe(expected);
  });

  describe.each(kinds)("%s dependency projection", (kind) => {
    it("projects the complete approved dependency set and excludes editing metadata", async () => {
      const source = inputFor(kind);
      const expected = expectedInput(kind);
      expect(api.projectMiniToolAnalysisInput(source)).toEqual(expected);
      const edited = { ...source, source: { ...source.source, nodeId: "50000000-0000-4000-8000-000000000002" }, draftId: otherDraftId, revision: nextRevision, runId: laterId, params: { ...source.params, dialogues: [{ dialogueId: "row-b", personId: "person-b", audioNodeId: "audio-b", startTime: 3 }], cuts: [3], clips: [], erasePrompt: "different erasure", quality: "low", encoding: "vp9", syncMode: "loop" } };
      expect(api.projectMiniToolAnalysisInput(edited)).toEqual(expected);
      expect(await api.fingerprintMiniToolAnalysisInput(api.projectMiniToolAnalysisInput(edited))).toBe(await api.fingerprintMiniToolAnalysisInput(expected));
    });

    it("changes the fingerprint for source and frozen profile changes, and restores it on reversal", async () => {
      const source = inputFor(kind);
      const original = await api.fingerprintMiniToolAnalysisInput(api.projectMiniToolAnalysisInput(source));
      const changes: AnalysisInputSource[] = [
        { ...source, source: { ...source.source, canonicalURL: "https://media.example.test/other.mp4" } },
        { ...source, profile: { ...profile, id: "other-detector" } },
        { ...source, profile: { ...profile, version: "2.0.0" } },
        { ...source, profile: { ...profile, weightsHash: "e".repeat(64) } },
        { ...source, profile: { ...profile, params: { ...profile.params, threshold: 0.7 } } },
        { ...source, profile: { ...profile, params: { ...profile.params, sampling: { everyNthFrame: 3, maxSide: 960 } } } },
      ];
      for (const changed of changes) expect(await api.fingerprintMiniToolAnalysisInput(api.projectMiniToolAnalysisInput(changed))).not.toBe(original);
      expect(await api.fingerprintMiniToolAnalysisInput(api.projectMiniToolAnalysisInput(inputFor(kind)))).toBe(original);
      expect(await api.fingerprintMiniToolAnalysisInput(api.projectMiniToolAnalysisInput({ ...source, currentProfile: { ...profile, version: "deployed-next" } }))).toBe(original);
    });

    it("normalizes nested object key order", async () => {
      const expected = expectedInput(kind);
      const reordered = { ...expected, profile: { params: { sampling: { maxSide: 960, everyNthFrame: 2 }, threshold: 0.4 }, weightsHash: null, version: "1.2.3", id: "detector-v1" } };
      expect(await api.fingerprintMiniToolAnalysisInput(reordered)).toBe(await api.fingerprintMiniToolAnalysisInput(expected));
    });

    it("normalizes arbitrary finite nested profile values without losing dependencies", async () => {
      await fc.assert(fc.asyncProperty(fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 1, max: 30 }), async (threshold, everyNthFrame) => {
        const source = inputFor(kind);
        const frozenProfile = { ...profile, params: { threshold, sampling: { everyNthFrame, maxSide: 960 } } };
        const projected = api.projectMiniToolAnalysisInput({ ...source, profile: frozenProfile });
        expect(projected).toEqual({ ...expectedInput(kind), profile: frozenProfile });
        const reordered = { ...projected, profile: { params: { sampling: { maxSide: 960, everyNthFrame }, threshold }, weightsHash: null, version: profile.version, id: profile.id } };
        expect(await api.fingerprintMiniToolAnalysisInput(reordered)).toBe(await api.fingerprintMiniToolAnalysisInput(projected));
      }));
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects non-finite relevant profile parameter %s", (threshold) => {
      expect(() => api.projectMiniToolAnalysisInput({ ...inputFor(kind), profile: { ...profile, params: { ...profile.params, threshold } } })).toThrow();
    });
  });

  it.each<AnalysisKind>(["scene_cuts"])("%s range changes invalidate reuse", async (kind) => {
    const source = inputFor(kind);
    expect(await api.fingerprintMiniToolAnalysisInput(api.projectMiniToolAnalysisInput({ ...source, params: { ...source.params, range: { start: 1, end: 4 } } }))).not.toBe(await api.fingerprintMiniToolAnalysisInput(api.projectMiniToolAnalysisInput(source)));
  });

});

describe("same-project copied analysis references", () => {
  const copiedDraftId = "20000000-0000-4000-8000-000000000002";

  it.each<AnalysisKind>(kinds)("reuses %s through a matching copied reference without rewriting acceptance", (kind) => {
    const record = recordFor(kind);
    const before = structuredClone(record);
    const reference = { version: 1, draftId: copiedDraftId, toolId: "video.split", kind, analysisRunId: record.analysisRunId, inputFingerprint: record.inputFingerprint };
    expect(api.selectMiniToolAnalyses([record], { draftId: copiedDraftId, kind, inputFingerprint: record.inputFingerprint, references: [reference] }))
      .toEqual({ latestAccepted: record, latestSuccessful: record });
    expect(record).toEqual(before);
  });

  it.each([
    {},
    { draftId: "20000000-0000-4000-8000-000000000003" },
    { analysisRunId: laterId },
    { inputFingerprint: "a".repeat(64) },
    { toolId: "video.extract-frames" },
    { version: 2 },
  ])("does not widen reuse for a missing or mismatched copied reference %j", (change) => {
    const record = recordFor("scene_cuts");
    const reference = { version: 1, draftId: copiedDraftId, toolId: "video.split", kind: "scene_cuts", analysisRunId: record.analysisRunId, inputFingerprint: record.inputFingerprint, ...change };
    const references = Object.keys(change).length === 0 ? [] : [reference];
    expect(api.selectMiniToolAnalyses([record], { draftId: copiedDraftId, kind: "scene_cuts", inputFingerprint: record.inputFingerprint, references }))
      .toEqual({ latestAccepted: null, latestSuccessful: null });
  });

  it("requires the current source dependency fingerprint even when the copied reference matches", () => {
    const record = recordFor("scene_cuts");
    const reference = { version: 1, draftId: copiedDraftId, toolId: "video.split", kind: "scene_cuts", analysisRunId: record.analysisRunId, inputFingerprint: record.inputFingerprint };
    expect(api.selectMiniToolAnalyses([record], { draftId: copiedDraftId, kind: "scene_cuts", inputFingerprint: "c".repeat(64), references: [reference] }))
      .toEqual({ latestAccepted: null, latestSuccessful: null });
  });
});
