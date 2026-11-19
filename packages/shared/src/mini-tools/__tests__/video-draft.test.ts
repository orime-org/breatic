// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

const toolIds = ["video.expand", "video.erase", "video.lip-sync", "video.remove-bg", "video.extract-frames", "video.transitions", "video.split"] as const;
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
  kind: "people" | "scene_cuts" | "tracked_mask";
  analysisRunId: string;
  inputFingerprint: string;
}
type DraftReading = { state: "absent" } | { state: "supported"; draft: Draft } | { state: "unsupported" | "invalid"; value: unknown };
interface DraftApi {
  videoToolDraftSchema: (toolId: VideoToolId) => { parse: (value: unknown) => Draft; safeParse: (value: unknown) => { success: boolean } };
  readVideoToolDraft: (toolId: VideoToolId, value: unknown) => DraftReading;
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
const dialogueId = "60000000-0000-4000-8000-000000000001";
const source = { nodeId: hostId, canonicalURL: "https://media.example.test/source.mp4", mediaInfo: { width: 960, height: 540, duration: 5, mimeType: "video/mp4" } };
const anchor = { frameIndex: 3 };
const params: Record<VideoToolId, ObjectValue> = {
  "video.expand": { frame: { x: 0, y: 0, width: 1, height: 1 }, ratio: "free", prompt: "" },
  "video.erase": { range: { start: 0, end: 5 }, anchor, region: { box: null, points: [] }, trackingPrompt: "" },
  "video.lip-sync": { anchor, dialogues: [{ dialogueId, personId: null, analysisRunId: null, audioInputId: null, startTime: 0 }], syncMode: "cut_off" },
  "video.remove-bg": {},
  "video.extract-frames": { mode: "current", frameIndex: 3 },
  "video.transitions": { clips: [] },
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

  // Execution design §10.4: Bria takes no prompt, so the erase draft keeps only the tracking prompt.
  it("refuses an erase draft that still carries an erase prompt", () => {
    const value = draftFor("video.erase");
    expect(api.videoToolDraftSchema("video.erase").safeParse({ ...value, params: { ...value.params, erasePrompt: "" } }).success).toBe(false);
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

  it.each([
    { x: 0.1, y: 0, width: 2, height: 2 },
    { x: 0, y: 0.1, width: 2, height: 2 },
    { x: -0.5, y: 0, width: 1, height: 1 },
    { x: 0, y: -0.5, width: 1, height: 1 },
  ])("rejects an expansion frame that loses part of the source %j", (frame) => {
    const value = draftFor("video.expand");
    expect(api.videoToolDraftSchema("video.expand").safeParse({ ...value, params: { ...value.params, frame } }).success).toBe(false);
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

  it("preserves a biased expansion and the chosen aspect ratio", () => {
    const value = draftFor("video.expand");
    value.params = { frame: { x: -0.125, y: -0.375, width: 1.375, height: 2 }, ratio: "free", prompt: "extend the scene" };
    expect(api.videoToolDraftSchema("video.expand").parse(value)).toEqual(value);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("rejects an invalid dialogue start time %s", (startTime) => {
    const value = draftFor("video.lip-sync");
    value.params = { ...value.params, dialogues: [{ dialogueId, personId: "person-a", analysisRunId: runId, audioInputId: inputId, startTime }] };
    expect(api.videoToolDraftSchema("video.lip-sync").safeParse(value).success).toBe(false);
  });

  it("preserves multiple independent dialogue rows for one person", () => {
    const value = draftFor("video.lip-sync");
    value.inputs = [{ inputId, url: "https://media.example.test/voice.m4a", mediaInfo: { duration: 5, mimeType: "audio/mp4" } }];
    value.params = { ...value.params, dialogues: [
      { dialogueId, personId: "person-a", analysisRunId: runId, audioInputId: inputId, startTime: 0 },
      { dialogueId: "60000000-0000-4000-8000-000000000002", personId: "person-a", analysisRunId: runId, audioInputId: inputId, startTime: 1.25 },
    ] };
    expect(api.videoToolDraftSchema("video.lip-sync").parse(value)).toEqual(value);
  });

  it("requires distinct dialogue identities for independently editable rows", () => {
    const value = draftFor("video.lip-sync");
    value.inputs = [{ inputId, url: "https://media.example.test/voice.m4a", mediaInfo: { duration: 5, mimeType: "audio/mp4" } }];
    const row = { dialogueId, personId: "person-a", analysisRunId: runId, audioInputId: inputId, startTime: 0 };
    value.params = { ...value.params, dialogues: [row, { ...row, startTime: 1.25 }] };
    expect(api.videoToolDraftSchema("video.lip-sync").safeParse(value).success).toBe(false);
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
    ["video.erase", "tracked_mask"],
    ["video.lip-sync", "people"],
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
      const wrongKind = kind === "people" ? "scene_cuts" : "people";
      expect(api.videoToolAnalysisRefSchema.safeParse({ ...refFor(toolId, kind), kind: wrongKind }).success).toBe(false);
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
