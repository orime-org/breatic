// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { MiniToolPlanRecipe, StudioAssetEntity } from "@breatic/shared";
import { miniToolAnalysisRecordSchema, type MiniToolAnalysisRecord } from "@breatic/shared/mini-tools";
import { assembleMiniToolPeopleAnalysis as assembleImpl, readMiniToolDisplayPeople, type MiniToolDisplayPeople,
  type MiniToolPeopleAnalysisResult, type MiniToolRegisteredAnalysisJob } from "../people-analysis.js";

// frames-split §7.16, §7.17: a thumbnail recipe is the anchor's grid frame plus the display crop, so the assembler checks each
// recipe's frame against the frozen anchor.
const assemble = assembleImpl;
// §93 D5-8 (design §7.17 人物检测锚帧 row): the people recipe on an entry carries no anchor, so the container's JSON echoes
// none, and it is measured in the recipe target's display geometry, which the reader checks (this round's choice: a third
// argument with the people recipe's target size; may be vetoed).
type ReadDisplay = (accepted: MiniToolAnalysisRecord, observations: unknown, target: { width: number; height: number }) => unknown;
const readDisplay = readMiniToolDisplayPeople as unknown as ReadDisplay;
const DISPLAY_TARGET = { width: 400, height: 200 };
/** Display people as the container now writes them: no anchor. */
type Display = Omit<MiniToolDisplayPeople, "anchor">;
// The anchor is grid frame 1 of a 4 fps grid: the grid, the tool source and the 400x200 display PNG target (frames-split §7.16, §7.17).
const GRID = { fps: { numerator: 4, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 20, realFrameCount: 20 } as const;
const TOOL_SOURCE = { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false } } as const;
const PNG_TARGET = { width: 400, height: 200, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } as const;
/** A grid frame recipe of the fixture. */
type GridFrame = Extract<MiniToolPlanRecipe, { kind: "frame"; frameIndex: number }>;

const RUN = "10000000-0000-4000-8000-000000000001";
const OTHER_RUN = "10000000-0000-4000-8000-000000000002";
const SOURCE = "20000000-0000-4000-8000-000000000001";
const OTHER_SOURCE = "20000000-0000-4000-8000-000000000002";
const KEY = "original/immutable-video.mp4";
const accepted = miniToolAnalysisRecordSchema.parse({
  schemaVersion: 1, draftId: "30000000-0000-4000-8000-000000000001", revision: "40000000-0000-4000-8000-000000000001",
  analysisRunId: RUN, acceptedAt: "2026-10-25T01:02:03.123456Z", kind: "people", inputFingerprint: "a".repeat(64),
  binding: { assetId: SOURCE, contentHash: "b".repeat(64), canonicalURL: "https://assets.test.invalid/original.mp4", kind: "video",
    mediaInfo: { width: 400, height: 200, duration: 12, mimeType: "video/mp4" } },
  analysisInput: { schemaVersion: 1, kind: "people", sourceURL: "https://assets.test.invalid/original.mp4", anchor: { frameIndex: 1 },
    profile: { id: "people-detector", version: "1", weightsHash: null, params: {} } },
  status: "running", result: null, error: null, usage: [], artifactUnavailable: false,
});
const display: Display = {
  schemaVersion: 1, kind: "people", coordinateSpace: "display", width: 400, height: 200,
  candidates: [
    { detectionIndex: 0, faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 }, pixelCrop: { x: 40, y: 20, width: 80, height: 60 } },
    { detectionIndex: 2, faceBox: { x: 0.5, y: 0.2, width: 0.1, height: 0.25 }, pixelCrop: { x: 200, y: 40, width: 40, height: 50 } },
    { detectionIndex: 5, faceBox: { x: 0.7, y: 0.5, width: 0.2, height: 0.3 }, pixelCrop: { x: 280, y: 100, width: 80, height: 60 } },
  ],
};
type DoneReport = Extract<MiniToolRegisteredAnalysisJob["report"], { state: "done" }>;
type Fixture = { observations: Display; job: MiniToolRegisteredAnalysisJob & { report: DoneReport }; expected: MiniToolPeopleAnalysisResult };

/** Project the canonical row exactly as a thumbnail reference. @returns The owned public reference. */
function reference(asset: StudioAssetEntity): MiniToolPeopleAnalysisResult["people"][number]["artifactRefs"][number] {
  if (asset.kind === "file") throw new Error("Fixture requires an image row");
  return { role: "thumbnail", assetId: asset.id, canonicalURL: asset.fileUrl, contentHash: asset.contentHash,
    kind: asset.kind, mimeType: asset.mimeType, size: asset.sizeBytes, frameMetadata: null };
}

/** Build independent original-plan facts from the oracle's declared candidate fixtures. @returns The mutable test fixture. */
function fixture(observations: Display = display, original: MiniToolAnalysisRecord = accepted): Fixture {
  const candidates = structuredClone(observations.candidates);
  const outputs = candidates.map((candidate) => ({ outputIndex: candidate.detectionIndex, storageKey: `declared/thumbnail-${candidate.detectionIndex}.png`,
    // frames-split §7.16, §7.17: each thumbnail is the anchor's grid frame of the tool source, cropped in the display geometry.
    contentType: "image/png", recipe: { kind: "frame" as const, inputId: SOURCE, grid: structuredClone(GRID), source: structuredClone(TOOL_SOURCE), frameIndex: 1,
      // The PNG target is the display geometry, which the crop's source size equals (shared FR02).
      target: { ...PNG_TARGET, width: observations.width, height: observations.height },
      crop: { sourceWidth: observations.width, sourceHeight: observations.height, rect: structuredClone(candidate.pixelCrop) } } }));
  const assets = candidates.map((candidate) => ({ outputIndex: candidate.detectionIndex, asset: {
    id: `50000000-0000-4000-8000-${String(candidate.detectionIndex + 1).padStart(12, "0")}`,
    studioId: "60000000-0000-4000-8000-000000000001", contentHash: candidate.detectionIndex.toString(16).padStart(64, "0"),
    storageKey: `canonical-winner/${candidate.detectionIndex}.png`, fileUrl: `https://assets.test.invalid/canonical-winner/${candidate.detectionIndex}.png`,
    sizeBytes: 100 + candidate.detectionIndex, mimeType: "image/png", kind: "image", source: "upload",
    producedByUserId: "70000000-0000-4000-8000-000000000001", generationTaskId: null,
    width: candidate.pixelCrop.width, height: candidate.pixelCrop.height, durationSeconds: null,
    createdAt: new Date("2026-10-24T00:00:00Z"), deletedAt: null,
  } satisfies StudioAssetEntity }));
  const measured = candidates.map((candidate, index) => ({ outputIndex: candidate.detectionIndex, storageKey: outputs[index]!.storageKey,
    sha256: assets[index]!.asset.contentHash, sizeBytes: assets[index]!.asset.sizeBytes, contentType: "image/png",
    width: candidate.pixelCrop.width, height: candidate.pixelCrop.height, durationSeconds: null, cover: null, upright: null }));
  const { status: _status, result: _result, error: _error, usage: _usage, artifactUnavailable: _unavailable, ...identity } = original;
  const expected: MiniToolPeopleAnalysisResult = { ...identity, kind: "people", anchor: { frameIndex: 1 },
    people: candidates.map((candidate, index) => ({ personId: `person:${original.analysisRunId}:${candidate.detectionIndex}`,
      faceBox: structuredClone(candidate.faceBox), artifactRefs: [reference(assets[index]!.asset)] })) };
  return { observations: structuredClone(observations), expected, job: {
    request: { schemaVersion: 2, jobId: "original-task-owned-thumbnail-job", containerClass: "OriginalClass", deadlineAt: 1792927200000,
      limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 }, inputs: [{ inputId: SOURCE, storageKey: KEY }], outputs },
    report: { schemaVersion: 2, state: "done", outputs: measured, usage: { wallMs: 1250, cpuUsec: 123456 } }, assets,
  } };
}

/** Require the fixture's declared frame recipe without weakening the production type. @returns The fixture's frame recipe. @throws {Error} When the fixture is not a frame. */
function frameRecipe(job: MiniToolRegisteredAnalysisJob, index = 1): GridFrame {
  const recipe = job.request.outputs[index]!.recipe;
  if (recipe.kind !== "frame" || !("frameIndex" in recipe)) throw new Error("Fixture requires a grid frame recipe");
  return recipe;
}

// P-A1–A3/P-I1–I2: independent oracle fixes noncontiguous indices and three different array orders.
describe("display people candidates and stable canonical thumbnails", () => {
  it("reads the exact display payload before planning its thumbnail jobs", () => {
    expect(readDisplay(accepted, display, DISPLAY_TARGET)).toEqual(display);
  });

  it("joins original indices 0/2/5 and preserves every accepted identity and canonical reference", () => {
    const f = fixture();
    f.job.request.outputs = [f.job.request.outputs[2]!, f.job.request.outputs[0]!, f.job.request.outputs[1]!];
    f.job.report.outputs = [f.job.report.outputs[1]!, f.job.report.outputs[2]!, f.job.report.outputs[0]!];
    f.job.assets = [f.job.assets[2]!, f.job.assets[1]!, f.job.assets[0]!];
    expect(assemble(accepted, KEY, display, [f.job])).toEqual(f.expected);
    expect(f.expected.people.map((person) => person.personId)).toEqual([`person:${RUN}:0`, `person:${RUN}:2`, `person:${RUN}:5`]);
  });

  it("preserves complete results under independent permutations of plans, measurements and registered rows", () => {
    fc.assert(fc.property(fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }),
      fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }), fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }), (a, b, c) => {
        const f = fixture();
        f.job.request.outputs = a.map((index) => f.job.request.outputs[index]!);
        f.job.report.outputs = b.map((index) => f.job.report.outputs[index]!);
        f.job.assets = c.map((index) => f.job.assets[index]!);
        expect(assemble(accepted, KEY, display, [f.job])).toEqual(f.expected);
      }));
  });

  it("keeps the supplied candidate order while retaining their original index identities", () => {
    const observations = { ...display, candidates: [display.candidates[2]!, display.candidates[0]!, display.candidates[1]!] };
    const f = fixture(observations);
    expect(assemble(accepted, KEY, observations, [f.job])).toEqual(f.expected);
    expect(f.expected.people.map((person) => person.personId)).toEqual([`person:${RUN}:5`, `person:${RUN}:0`, `person:${RUN}:2`]);
  });

  it("retains a lone index5 without requiring missing detector indices", () => {
    const f = fixture({ ...display, candidates: [display.candidates[2]!] });
    expect(assemble(accepted, KEY, f.observations, [f.job])).toEqual(f.expected);
  });

  it("allows an actual portrait display geometry independent of encoded binding geometry", () => {
    const f = fixture({ ...display, width: 200, height: 400, candidates: [{ detectionIndex: 2,
      faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 }, pixelCrop: { x: 20, y: 40, width: 40, height: 120 } }] });
    expect(assemble(accepted, KEY, f.observations, [f.job])).toEqual(f.expected);
  });

  it("assembles nine candidates across original groups of eight and one in reversed job order", () => {
    const observations = { ...display, candidates: Array.from({ length: 9 }, (_, index) => ({ ...display.candidates[0]!, detectionIndex: index * 2 })) };
    const f = fixture(observations);
    const first = { ...f.job, request: { ...f.job.request, outputs: f.job.request.outputs.slice(0, 8) },
      report: { ...f.job.report, outputs: f.job.report.outputs.slice(0, 8) }, assets: f.job.assets.slice(0, 8) };
    const last = { ...f.job, request: { ...f.job.request, jobId: "original-task-owned-thumbnail-second", outputs: f.job.request.outputs.slice(8) },
      report: { ...f.job.report, outputs: f.job.report.outputs.slice(8) }, assets: f.job.assets.slice(8) };
    expect(assemble(accepted, KEY, observations, [last, first])).toEqual(f.expected);
    expect(f.expected.people.map((person) => person.personId)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16].map((index) => `person:${RUN}:${index}`));
  });

  it("returns an exact empty result with no zero-output thumbnail job", () => {
    const f = fixture({ ...display, candidates: [] });
    expect(readDisplay(accepted, f.observations, DISPLAY_TARGET)).toEqual(f.observations);
    expect(assemble(accepted, KEY, f.observations, [])).toEqual(f.expected);
  });

  // P-R10–R13/R17: canonical dedup metadata describes the original row, not this use.
  it.each([{ width: null, height: null }, { width: null, height: 50 }, { width: 40, height: null }])("accepts nullable canonical image dimensions: %j", (dimensions) => {
    const f = fixture(); Object.assign(f.job.assets[1]!.asset, dimensions);
    expect(assemble(accepted, KEY, display, [f.job])).toEqual(f.expected);
  });

  it("projects the canonical row's actual MIME rather than the requested PNG subtype", () => {
    const f = fixture(); f.job.assets[1]!.asset.mimeType = "image/webp";
    f.expected.people[1]!.artifactRefs[0]!.mimeType = "image/webp";
    expect(assemble(accepted, KEY, display, [f.job])).toEqual(f.expected);
  });

  it("retains a dedup winner's earlier upload producer and generation ownership", () => {
    const f = fixture(); f.job.assets[1]!.asset.generationTaskId = "80000000-0000-4000-8000-000000000001";
    expect(assemble(accepted, KEY, display, [f.job])).toEqual(f.expected);
  });

  it("allows distinct people to reference the same actual deduplicated image", () => {
    const f = fixture(); f.job.assets[2]!.asset = structuredClone(f.job.assets[0]!.asset);
    f.job.report.outputs[2]!.sha256 = f.job.report.outputs[0]!.sha256;
    f.job.report.outputs[2]!.sizeBytes = f.job.report.outputs[0]!.sizeBytes;
    f.expected.people[2]!.artifactRefs = structuredClone(f.expected.people[0]!.artifactRefs);
    expect(assemble(accepted, KEY, display, [f.job])).toEqual(f.expected);
  });

  // P-I3–I7: identity is run/index; result content remains a separate first-result fact.
  it("scopes an otherwise identical index2 to the new accepted run", () => {
    const original = miniToolAnalysisRecordSchema.parse({ ...accepted, analysisRunId: OTHER_RUN });
    const f = fixture({ ...display, candidates: [display.candidates[1]!] }, original);
    expect(assemble(original, KEY, f.observations, [f.job])).toEqual(f.expected);
    expect(f.expected.people[0]!.personId).toBe(`person:${OTHER_RUN}:2`);
  });

  it("returns exact run-scoped IDs and the same canonical result on repeated assembly", () => {
    const f = fixture();
    const first = assemble(accepted, KEY, display, [f.job]);
    expect(first).toEqual(f.expected);
    expect(first.people.map((person) => person.personId)).toEqual([
      "person:10000000-0000-4000-8000-000000000001:0",
      "person:10000000-0000-4000-8000-000000000001:2",
      "person:10000000-0000-4000-8000-000000000001:5",
    ]);
    expect(first.acceptedAt).toBe("2026-10-25T01:02:03.123456Z");
    expect(assemble(accepted, KEY, display, [f.job])).toEqual(first);
  });

  it("changes identity with the original detector index even for identical box and thumbnail bytes", () => {
    const index2 = { ...display.candidates[0]!, detectionIndex: 2 };
    const index5 = { ...display.candidates[0]!, detectionIndex: 5 };
    const a = fixture({ ...display, candidates: [index2] });
    const b = fixture({ ...display, candidates: [index5] });
    b.job.assets[0]!.asset = structuredClone(a.job.assets[0]!.asset);
    b.job.report.outputs[0]!.sha256 = a.job.report.outputs[0]!.sha256;
    b.job.report.outputs[0]!.sizeBytes = a.job.report.outputs[0]!.sizeBytes;
    b.expected.people[0]!.artifactRefs = structuredClone(a.expected.people[0]!.artifactRefs);
    const first = assemble(accepted, KEY, a.observations, [a.job]);
    expect(first).toEqual(a.expected);
    const second = assemble(accepted, KEY, b.observations, [b.job]);
    expect(second).toEqual(b.expected);
    expect(first.people[0]!.personId).toBe("person:10000000-0000-4000-8000-000000000001:2");
    expect(second.people[0]!.personId).toBe("person:10000000-0000-4000-8000-000000000001:5");
  });

  it("retains the same index identity when valid candidate content differs", () => {
    const f = fixture(); f.observations.candidates[1]!.faceBox.x = 0.51;
    f.expected.people[1]!.faceBox.x = 0.51;
    expect(assemble(accepted, KEY, f.observations, [f.job])).toEqual(f.expected);
  });

  it("constructs a late failed-run result without changing the accepted failure facts or input arrays", () => {
    const original = miniToolAnalysisRecordSchema.parse({ ...accepted, status: "failed", error: { code: "expired" } });
    const f = fixture(display, original); const before = structuredClone({ original, f });
    expect(assemble(original, KEY, display, [f.job])).toEqual(f.expected);
    expect({ original, f }).toEqual(before);
  });
});

// P-A4–A8: malformed registered content must never become an empty or partial success.
describe("display people content boundaries", () => {
  const invalidPayloads = [
    { name: "missing coordinate space", patch: { coordinateSpace: undefined } },
    { name: "raw coordinates", patch: { coordinateSpace: "raw" } },
    { name: "unknown coordinate space", patch: { coordinateSpace: "screen" } },
    { name: "wrong version", patch: { schemaVersion: 2 } }, { name: "wrong kind", patch: { kind: "scene_cuts" } },
    // §93 D5-8: the anchor is the accepted one, never read back from the container.
    { name: "an anchor echo", patch: { anchor: { frameIndex: 1 } } },
    { name: "non-array candidates", patch: { candidates: {} } },
    { name: "missing candidate object", patch: { candidates: [null] } },
    { name: "duplicate detector identity", patch: { candidates: [display.candidates[0], display.candidates[0]] } },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, undefined, "2"].map((detectionIndex) => ({ name: `invalid detector index ${detectionIndex}`,
      patch: { candidates: [{ ...display.candidates[0], detectionIndex }] } })),
    ...[{ x: -0.1, y: 0, width: 0.2, height: 0.2 }, { x: 0.9, y: 0, width: 0.2, height: 0.2 },
      { x: 0, y: 0.9, width: 0.2, height: 0.2 }, { x: 0, y: 0, width: 0, height: 0.2 },
      { x: 0, y: 0, width: 0.2, height: 0 }, { x: NaN, y: 0, width: 0.2, height: 0.2 },
      { x: 0, y: 0, width: Infinity, height: 0.2 }, { x: 0, y: 0, width: "0.2", height: 0.2 }, undefined].map((faceBox, index) => ({
      name: `invalid face box ${index}`, patch: { candidates: [{ ...display.candidates[0], faceBox }] } })),
    ...[undefined, { x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: -1, width: 1, height: 1 },
      { x: 0, y: 0, width: 0, height: 1 }, { x: 0, y: 0, width: 1, height: 0 }, { x: 399, y: 0, width: 2, height: 1 },
      { x: 0, y: 199, width: 1, height: 2 }, { x: 0.5, y: 0, width: 1, height: 1 }, { x: 0, y: 0.5, width: 1, height: 1 },
      { x: 0, y: 0, width: 1.5, height: 1 }, { x: 0, y: 0, width: 1, height: 1.5 }, { x: 0, y: 0, width: Infinity, height: 1 }].map((pixelCrop, index) => ({
      name: `invalid saved pixel rectangle ${index}`, patch: { candidates: [{ ...display.candidates[0], pixelCrop }] } })),
    ...[0, -1, 0.5, Infinity, undefined, "400"].flatMap((value) => [
      { name: `invalid width ${value}`, patch: { width: value } }, { name: `invalid height ${value}`, patch: { height: value } },
    ]),
  ];

  it.each(invalidPayloads)("refuses $name in both display reading and complete assembly", ({ patch }) => {
    const f = fixture(); const observations = { ...display, ...patch };
    expect(() => readDisplay(accepted, observations, DISPLAY_TARGET)).toThrow();
    expect(() => assemble(accepted, KEY, observations, [f.job])).toThrow();
  });

  // §93 D5-8: the detector ran on the recipe target, so other measured geometry is not this job's output.
  it.each([{ width: 200, height: 400 }, { width: 400, height: 199 }])("refuses display people measured at %j instead of the 400x200 target", (size) => {
    expect(() => readDisplay(accepted, { ...display, ...size, candidates: [] }, DISPLAY_TARGET)).toThrow();
  });

  it("requires the originally accepted analysis to be people", () => {
    const original = miniToolAnalysisRecordSchema.parse({ ...accepted, kind: "scene_cuts", analysisInput: { schemaVersion: 1, kind: "scene_cuts",
      sourceURL: accepted.binding.canonicalURL, profile: accepted.analysisInput.profile, range: { start: 0, end: 1 } } });
    expect(() => readDisplay(original, display, DISPLAY_TARGET)).toThrow();
    expect(() => assemble(original, KEY, display, [fixture().job])).toThrow();
  });
});

// P-A9–A13/P-R1–R9: plans, measured bytes and canonical rows must all name the same candidate.
describe("complete original thumbnail associations", () => {
  it.each([
    { name: "missing original alias", change: (f: Fixture) => { f.job.request.inputs = [{ inputId: OTHER_SOURCE, storageKey: KEY }]; } },
    { name: "wrong original key", change: (f: Fixture) => { f.job.request.inputs[0]!.storageKey = "different/source.mp4"; } },
    { name: "another alias alone maps the original key", change: (f: Fixture) => {
      f.job.request.inputs = [{ inputId: SOURCE, storageKey: "different/source.mp4" }, { inputId: OTHER_SOURCE, storageKey: KEY }];
    } },
    { name: "duplicated original alias", change: (f: Fixture) => { f.job.request.inputs.push({ inputId: SOURCE, storageKey: KEY }); } },
    { name: "recipe uses another valid source alias", change: (f: Fixture) => {
      f.job.request.inputs.push({ inputId: OTHER_SOURCE, storageKey: "different/source.mp4" }); frameRecipe(f.job).inputId = OTHER_SOURCE;
    } },
    // Another kind is a people recipe on the same grid frame.
    { name: "another recipe kind", change: (f: Fixture) => { f.job.request.outputs[1]!.recipe = { kind: "people", inputId: SOURCE, grid: structuredClone(GRID), source: structuredClone(TOOL_SOURCE), frameIndex: 1,
      target: { ...PNG_TARGET }, profile: { id: "people-detector", version: "1", weightsHash: null, params: {} } } as unknown as MiniToolPlanRecipe; } },
    // frames-split §7.16: the thumbnail is the anchor's grid frame.
    { name: "another grid frame", change: (f: Fixture) => { frameRecipe(f.job).frameIndex = 2; } },
    { name: "missing saved crop", change: (f: Fixture) => { delete frameRecipe(f.job).crop; } },
    { name: "wrong crop source width", change: (f: Fixture) => { frameRecipe(f.job).crop!.sourceWidth = 401; } },
    { name: "wrong crop source height", change: (f: Fixture) => { frameRecipe(f.job).crop!.sourceHeight = 201; } },
    ...(["x", "y", "width", "height"] as const).map((field) => ({ name: `changed saved crop ${field}`, change: (f: Fixture) => {
      frameRecipe(f.job).crop!.rect[field] -= 1;
    } })),
    { name: "another candidate rectangle", change: (f: Fixture) => { frameRecipe(f.job).crop!.rect = structuredClone(display.candidates[0]!.pixelCrop); } },
    { name: "missing planned output", change: (f: Fixture) => { f.job.request.outputs.pop(); } },
    { name: "missing done measurement", change: (f: Fixture) => { f.job.report.outputs.pop(); } },
    { name: "missing registered row", change: (f: Fixture) => { f.job.assets.pop(); } },
    { name: "foreign planned output index", change: (f: Fixture) => { f.job.request.outputs[1]!.outputIndex = 9; } },
    { name: "foreign measured output index", change: (f: Fixture) => { f.job.report.outputs[1]!.outputIndex = 9; } },
    { name: "foreign registered output index", change: (f: Fixture) => { f.job.assets[1]!.outputIndex = 9; } },
    { name: "duplicate planned index", change: (f: Fixture) => { f.job.request.outputs.push(structuredClone(f.job.request.outputs[1]!)); } },
    { name: "duplicate measured index", change: (f: Fixture) => { f.job.report.outputs.push(structuredClone(f.job.report.outputs[1]!)); } },
    { name: "duplicate registered index", change: (f: Fixture) => { f.job.assets.push(structuredClone(f.job.assets[1]!)); } },
    { name: "foreign measured storage key", change: (f: Fixture) => { f.job.report.outputs[1]!.storageKey = "foreign/thumbnail.png"; } },
    { name: "wrong requested MIME", change: (f: Fixture) => { f.job.request.outputs[1]!.contentType = "image/jpeg"; f.job.report.outputs[1]!.contentType = "image/jpeg"; } },
    { name: "wrong measured MIME", change: (f: Fixture) => { f.job.report.outputs[1]!.contentType = "image/jpeg"; } },
    { name: "foreign measured cover", change: (f: Fixture) => { f.job.report.outputs[1]!.cover = { storageKey: "foreign/cover.png", sha256: "c".repeat(64),
      sizeBytes: 20, contentType: "image/png", width: 1, height: 1 }; } },
    ...(["width", "height"] as const).flatMap((field) => [
      { name: `wrong measured ${field}`, change: (f: Fixture) => { f.job.report.outputs[1]![field] = 1; } },
      { name: `missing measured ${field}`, change: (f: Fixture) => { f.job.report.outputs[1]![field] = null; } },
    ]),
    { name: "wrong cached row hash", change: (f: Fixture) => { f.job.assets[1]!.asset.contentHash = "c".repeat(64); } },
    { name: "wrong cached row byte size", change: (f: Fixture) => { f.job.assets[1]!.asset.sizeBytes += 1; } },
    { name: "deleted canonical row", change: (f: Fixture) => { f.job.assets[1]!.asset.deletedAt = new Date("2026-10-25T00:00:00Z"); } },
    { name: "nonimage registered row", change: (f: Fixture) => { f.job.assets[1]!.asset.kind = "document"; } },
  ])("refuses $name without publishing a partial result", ({ change }) => {
    const f = fixture(); change(f);
    expect(() => assemble(accepted, KEY, display, [f.job])).toThrow();
  });

  // Consistent recipes are still refused when they all name another grid frame than the anchor's (frames-split §7.16).
  it("refuses thumbnails whose recipes all name another grid frame than the anchor's", () => {
    const f = fixture();
    for (const output of f.job.request.outputs) if (output.recipe.kind === "frame" && "frameIndex" in output.recipe) output.recipe.frameIndex = 2;
    expect(() => assemble(accepted, KEY, display, [f.job])).toThrow();
  });

  it.each(["starting", "running"] as const)("refuses a %s report", (state) => {
    const f = fixture();
    expect(() => assemble(accepted, KEY, display, [{ ...f.job, report: { schemaVersion: 2, state } }])).toThrow();
  });

  it.each([false, true])("refuses a failed job even when its written set is complete=%s", (complete) => {
    const f = fixture();
    const job: MiniToolRegisteredAnalysisJob = { ...f.job, report: { ...f.job.report, state: "failed", reason: "tool_failed",
      outputs: complete ? f.job.report.outputs : f.job.report.outputs.slice(0, 1) } };
    const before = structuredClone(job);
    expect(() => assemble(accepted, KEY, display, [job])).toThrow();
    expect(job).toEqual(before);
  });

  it("refuses duplicate candidate ownership across two original jobs", () => {
    const f = fixture(); const duplicate = structuredClone(f.job); duplicate.request.jobId = "another-original-job";
    expect(() => assemble(accepted, KEY, display, [f.job, duplicate])).toThrow();
  });

  it("checks the original source mapping in the second thumbnail job", () => {
    const first = fixture({ ...display, candidates: [display.candidates[0]!] });
    const second = fixture({ ...display, candidates: display.candidates.slice(1) });
    second.job.request.jobId = "second-original-job"; second.job.request.inputs[0]!.storageKey = "wrong/second-source.mp4";
    expect(() => assemble(accepted, KEY, display, [first.job, second.job])).toThrow();
  });

  it("refuses missing jobs for nonempty candidates", () => {
    expect(() => assemble(accepted, KEY, display, [])).toThrow();
  });

  it("refuses thumbnail jobs for an empty candidate set", () => {
    expect(() => assemble(accepted, KEY, { ...display, candidates: [] }, [fixture().job])).toThrow();
  });
});
