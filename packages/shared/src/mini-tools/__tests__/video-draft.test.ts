// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

const toolIds = ["video.extract-frames", "video.split"] as const;
type VideoToolId = typeof toolIds[number];
type ObjectValue = Record<string, unknown>;
interface Draft {
  version: 1;
  draftId: string;
  revision: string;
  source: { nodeId: string; canonicalURL: string; mediaInfo: { width: number; height: number; duration: number; mimeType: string } };
  params: ObjectValue;
  inputs: { inputId: string; url: string; cover?: string; mediaInfo?: ObjectValue; sourceNodeId?: string }[];
}
interface AnalysisRef {
  version: 1;
  draftId: string;
  toolId: VideoToolId;
  kind: "scene_cuts";
  analysisRunId: string;
  inputFingerprint: string;
}
type DraftReading = { state: "absent" } | { state: "supported" | "stale"; draft: Draft } | { state: "unsupported" | "invalid"; value: unknown };
interface PresentationRef { source: { toolInputId: string; planSha256: string } }
interface DraftApi {
  videoToolDraftSchema: (toolId: VideoToolId) => { parse: (value: unknown) => Draft; safeParse: (value: unknown) => { success: boolean } };
  readVideoToolDraft: (toolId: VideoToolId, value: unknown, presentationRef?: PresentationRef) => DraftReading;
  videoToolAnalysisRefSchema: { parse: (value: unknown) => AnalysisRef; safeParse: (value: unknown) => { success: boolean } };
  videoToolDraftAssetUrls: (draft: Draft) => string[];
  videoToolAnalysisRefs: (data: Readonly<Record<string, unknown>>) => AnalysisRef[];
}

const api = miniTools as unknown as DraftApi;
const draftId = "10000000-0000-4000-8000-000000000001";
const revision = "20000000-0000-4000-8000-000000000001";
const hostId = "30000000-0000-4000-8000-000000000001";
const inputId = "40000000-0000-4000-8000-000000000001";
const runId = "50000000-0000-4000-8000-000000000001";
const otherRunId = "50000000-0000-4000-8000-000000000002";
const source = { nodeId: hostId, canonicalURL: "https://media.example.test/source.mp4", mediaInfo: { width: 960, height: 540, duration: 5, mimeType: "video/mp4" } };
const params: Record<VideoToolId, ObjectValue> = {
  "video.extract-frames": { mode: "current", frameIndex: 3 },
  "video.split": { cuts: [1], sensitivity: 0.4 },
};

/**
 * Builds a complete scalar using approved per-tool domain fields.
 * @param toolId - The tool whose parameters are retained.
 * @returns Its independent fixture.
 * @throws {never} Never.
 */
function draftFor(toolId: VideoToolId): Draft {
  return { version: 1, draftId, revision, source: structuredClone(source), params: structuredClone(params[toolId]), inputs: [] };
}

/**
 * Builds one accepted analysis reference.
 * @param toolId - The consuming tool.
 * @param kind - Its analysis kind.
 * @returns A complete reference.
 * @throws {never} Never.
 */
function refFor(toolId: VideoToolId, kind: AnalysisRef["kind"]): AnalysisRef {
  return { version: 1, draftId, toolId, kind, analysisRunId: runId, inputFingerprint: "a".repeat(64) };
}

describe("persistent video tool draft contract", () => {
  it("exports the schema, reader and reference entry points", () => {
    expect(["videoToolDraftSchema", "readVideoToolDraft", "videoToolAnalysisRefSchema", "videoToolDraftAssetUrls", "videoToolAnalysisRefs"].filter((key) => !(key in miniTools))).toEqual([]);
  });

  describe.each(toolIds)("%s scalar draft", (toolId) => {
    it("preserves the complete source, parameter and input snapshot", () => {
      const value = draftFor(toolId);
      expect(api.videoToolDraftSchema(toolId).parse(value)).toEqual(value);
      expect(api.readVideoToolDraft(toolId, value)).toEqual({ state: "supported", draft: value });
    });

    it.each(["version", "draftId", "revision", "source", "params", "inputs"])("requires the %s field", (field) => {
      const value: ObjectValue = { ...draftFor(toolId) };
      delete value[field];
      expect(api.videoToolDraftSchema(toolId).safeParse(value).success).toBe(false);
    });

    it.each(["draftId", "revision"])("requires a UUID for %s", (field) => {
      expect(api.videoToolDraftSchema(toolId).safeParse({ ...draftFor(toolId), [field]: "invalid-id" }).success).toBe(false);
    });

    it("separates absent, unknown-version and invalid states while preserving raw data", () => {
      const unknown = { ...draftFor(toolId), version: 9, futureField: { value: true } };
      const invalid = { ...draftFor(toolId), revision: "invalid-id" };
      expect(api.readVideoToolDraft(toolId, undefined)).toEqual({ state: "absent" });
      expect(api.readVideoToolDraft(toolId, unknown)).toEqual({ state: "unsupported", value: unknown });
      expect(api.readVideoToolDraft(toolId, invalid)).toEqual({ state: "invalid", value: invalid });
      expect(api.readVideoToolDraft(toolId, null)).toEqual({ state: "invalid", value: null });
    });

    it("keeps copied audio and video inputs with their own source identities", () => {
      const value = draftFor(toolId);
      value.inputs = [
        { inputId, url: "https://media.example.test/voice.m4a", sourceNodeId: hostId, mediaInfo: { duration: 5, mimeType: "audio/mp4" } },
        { inputId: "40000000-0000-4000-8000-000000000002", url: "https://media.example.test/detail.mp4", cover: "https://media.example.test/detail.jpg", mediaInfo: { width: 640, height: 360, duration: 4, mimeType: "video/mp4" } },
      ];
      expect(api.videoToolDraftSchema(toolId).parse(value)).toEqual(value);
    });

    it("round-trips valid UUID identities through serialization", () => {
      fc.assert(fc.property(fc.uuid(), fc.uuid(), (nextDraftId, nextRevision) => {
        const value = { ...draftFor(toolId), draftId: nextDraftId, revision: nextRevision };
        expect(api.videoToolDraftSchema(toolId).parse(JSON.parse(JSON.stringify(value)) as unknown)).toEqual(value);
      }));
    });
  });

  // §97 (frames-split §10.6 删除行; tools design acceptance item 5): the frame draft keeps first, last and current only.
  it.each([
    ["the interval mode", { mode: "interval", frameIndex: 3, interval: 1 }],
    ["an interval period beside a kept mode", { mode: "current", frameIndex: 3, interval: 1 }],
    // frames-split §4.3, §10.7: the current frame is a grid frame, never seconds.
    ["a current time in seconds", { mode: "current", currentTime: 0.12 }],
  ])("the frame draft refuses %s", (_name, frameParams) => {
    const value = draftFor("video.extract-frames");
    expect(api.videoToolDraftSchema("video.extract-frames").safeParse(value).success).toBe(true);
    expect(api.videoToolDraftSchema("video.extract-frames").safeParse({ ...value, params: frameParams }).success).toBe(false);
  });

  // frames-split §10.7 分割 row: cuts are grid frame numbers, kept as edited (planVideoSplit drops the edges and duplicates).
  it("preserves manually editable split cuts with an explicit sensitivity", () => {
    const value = draftFor("video.split");
    value.params = { cuts: [0, 1, 3, 3, 125], sensitivity: 0.4 };
    expect(api.videoToolDraftSchema("video.split").parse(value)).toEqual(value);
    expect(api.videoToolDraftSchema("video.split").safeParse({ ...value, params: { cuts: [0.04], sensitivity: 0.4 } }).success).toBe(false);
  });

  it("enumerates source and copied input URLs for every supported draft", () => {
    for (const toolId of toolIds) {
      const value = draftFor(toolId);
      value.inputs = [
        { inputId, url: "https://media.example.test/voice.m4a" },
        { inputId: "40000000-0000-4000-8000-000000000002", url: source.canonicalURL, cover: "https://media.example.test/cover.jpg" },
      ];
      expect(api.videoToolDraftAssetUrls(value)).toEqual([source.canonicalURL, "https://media.example.test/voice.m4a", "https://media.example.test/cover.jpg"]);
    }
  });

  describe.each([
    ["video.split", "scene_cuts"],
  ] as const)("%s analysis reference", (toolId, kind) => {
    it("preserves its complete accepted identity", () => {
      const value = refFor(toolId, kind);
      expect(api.videoToolAnalysisRefSchema.parse(value)).toEqual(value);
    });

    it.each(["version", "draftId", "toolId", "kind", "analysisRunId", "inputFingerprint"])("requires the %s field", (field) => {
      const value: ObjectValue = { ...refFor(toolId, kind) };
      delete value[field];
      expect(api.videoToolAnalysisRefSchema.safeParse(value).success).toBe(false);
    });

    it("requires the tool's actual analysis kind", () => {
      expect(api.videoToolAnalysisRefSchema.safeParse({ ...refFor(toolId, kind), kind: "people" }).success).toBe(false);
    });

    it("enumerates independently accepted runs and verifies each run key", () => {
      const first = refFor(toolId, kind);
      const second = { ...first, analysisRunId: otherRunId };
      expect(api.videoToolAnalysisRefs({
        [`miniToolAnalysis:${runId}`]: first,
        [`miniToolAnalysis:${otherRunId}`]: second,
        [`miniToolDraft:${toolId}`]: draftFor(toolId),
        "miniToolAnalysis:invalid-id": first,
        "miniToolAnalysis:50000000-0000-4000-8000-000000000003": first,
        unrelated: first,
      })).toEqual([first, second]);
    });
  });
});

// frames-split §7.13 Dv: every draft holds the selected version's presentationRef, and a draft whose ref is not the selected
// one's is stale: its values stay, but they are not read as frame numbers of the new grid.
describe("a draft's presentationRef (frames-split §7.13 Dv)", () => {
  const selected: PresentationRef = { source: { toolInputId: "a".repeat(64), planSha256: "b".repeat(64) } };

  it.each(toolIds)("stores the presentationRef with the parameters of %s", (toolId) => {
    const draft = { ...draftFor(toolId), presentationRef: selected };
    expect(api.videoToolDraftSchema(toolId).parse(draft)).toEqual(draft);
    expect(api.videoToolDraftSchema(toolId).safeParse({ ...draft, presentationRef: { source: { toolInputId: "x", planSha256: "b".repeat(64) } } }).success).toBe(false);
  });

  it.each(toolIds)("reads %s as current only under the selected version's toolInputId and planSha256", (toolId) => {
    const draft = { ...draftFor(toolId), presentationRef: selected };
    expect(api.readVideoToolDraft(toolId, draft, selected)).toEqual({ state: "supported", draft });
    expect(api.readVideoToolDraft(toolId, draft, { source: { ...selected.source, planSha256: "c".repeat(64) } })).toEqual({ state: "stale", draft });
    expect(api.readVideoToolDraft(toolId, draft, { source: { ...selected.source, toolInputId: "c".repeat(64) } })).toEqual({ state: "stale", draft });
  });

  it("reads a saved draft without a presentationRef as stale, keeping its values", () => {
    const draft = draftFor("video.split");
    expect(api.readVideoToolDraft("video.split", draft, selected)).toEqual({ state: "stale", draft });
  });

  it("classifies by schema alone while no version is selected", () => {
    const draft = draftFor("video.split");
    expect(api.readVideoToolDraft("video.split", draft)).toEqual({ state: "supported", draft });
  });

  it("is stale for any ref other than the selected one", () => {
    const hex = fc.stringMatching(/^[a-f0-9]{64}$/);
    fc.assert(fc.property(hex, hex, (toolInputId, planSha256) => {
      const stored = { source: { toolInputId, planSha256 } };
      const reading = api.readVideoToolDraft("video.split", { ...draftFor("video.split"), presentationRef: stored }, selected);
      return reading.state === (toolInputId === selected.source.toolInputId && planSha256 === selected.source.planSha256 ? "supported" : "stale");
    }));
  });
});
