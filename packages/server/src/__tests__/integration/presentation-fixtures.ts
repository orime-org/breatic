// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A registered source's selected presentation version as ingest answers it on the frame grid (frames-split design §3.5):
 * the snapshot and the selected bundle. Every value is deterministic for a given source hash and key, so golden plans
 * that embed the bundle can be hashed independently. 1011 grid frames at 200 fps give a display duration of exactly
 * 5.055 s, the registered duration of the removal fixtures; the tools read the original, with a keyframe every 1.25 s.
 */

import * as shared from "@breatic/shared";

/** One input's tool-input reference (§7.13). */
export interface ToolInputRef { toolInputId: string; planSha256: string }
/** The selected version and the snapshot that names it. */
export interface PresentedSource {
  presentationRef: { source: ToolInputRef };
  versionId: string;
  bundle: shared.VideoPresentationVersion;
  snapshot: Record<string, unknown>;
}

const DIGEST = "d".repeat(64);
export const REMOVAL_VERSION_ID = "e".repeat(64);
export const REMOVAL_PLAN: shared.VideoPresentationPlan = {
  gridRulesVersion: shared.GRID_RULES_VERSION,
  grid: { fps: { numerator: 200, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, leadFrames: 0, gridEnd: null, singleFrameDurationMs: 5000 },
  toolSource: "original", audioTrack: null, display: { width: 960, height: 540 }, color: { matrix: "bt601", toneMap: "none" }, framePngBitDepth: 8,
};
export const REMOVAL_KEYFRAMES: shared.SourceKeyframeStats = { earliestKeyframeTime: 0, maxKeyframeInterval: 1.25, allKeyframes: false };
export const REMOVAL_DISPLAY = {
  width: 960, height: 540, fps: { numerator: 200, denominator: 1 }, frameCount: 1011, gridStart: { numerator: 0, denominator: 1 }, realFrameCount: 1011, leadFrames: 0, holdFrames: 0,
};

/** What the selected version carries besides the removal source's defaults. */
export interface PresentedOptions {
  /** The selected plan; the removal source's when absent. */
  plan?: shared.VideoPresentationPlan;
  /** The tools read an edit file (frames-split §4.2) whose key is a presentation work key of the source. */
  edit?: boolean;
  /** The playback file is alpha-packed (a transparent source, §4.3). */
  transparent?: boolean;
  /** The source keyframe statistics (§7.16); a keyframe every 1.25 s when absent. */
  keyframes?: shared.SourceKeyframeStats;
}

/**
 * The edit file's key of a source in these fixtures.
 * @param sourceKey - The registered storage key.
 * @returns The key.
 * @throws {never} Never.
 */
export function editKeyOf(sourceKey: string): string {
  return shared.videoPresentationWorkKeyFor(sourceKey, "video-presentation:edit-job:edit.mp4");
}

/**
 * The selected version of one registered source.
 * @param hash - The registered content hash.
 * @param sourceKey - The registered storage key.
 * @param publicUrl - The storage's public URL function.
 * @param options - The plan, edit file, transparency and keyframes; the removal source's by default.
 * @returns Its bundle, reference and snapshot.
 * @throws {z.ZodError} When the plan or the bundle is not valid.
 */
export async function presentedSource(hash: string, sourceKey: string, publicUrl: (key: string) => string, options: PresentedOptions = {}): Promise<PresentedSource> {
  const plan = options.edit ? { ...(options.plan ?? REMOVAL_PLAN), toolSource: "edit" as const } : (options.plan ?? REMOVAL_PLAN);
  const receipt = (key: string, contentType: string, sha256: string): Record<string, unknown> => ({ storageKey: key, url: publicUrl(key), etag: `etag-${key}`, size: 4096, sha256, contentType });
  const edit = options.edit ? { ...receipt(editKeyOf(sourceKey), "video/mp4", "a".repeat(64)), editProfileVersion: DIGEST, tier: "edit_h264_intra_8bit_420" } : null;
  const planSha256 = await shared.videoPresentationPlanSha256(plan);
  const toolInputId = await shared.videoPresentationToolInputId({ sourceFingerprint: hash, planSha256, editFileSha256: edit === null ? null : "a".repeat(64) });
  const playback = options.transparent
    ? { kind: "alpha-packed", carrier: receipt(shared.videoPresentationWorkKeyFor(sourceKey, "video-presentation:edit-job:packed.mp4"), "video/mp4", "b".repeat(64)), manifest: receipt(shared.videoPresentationWorkKeyFor(sourceKey, "video-presentation:edit-job:alpha.json"), "application/json", "c".repeat(64)) }
    : { kind: "native", carrier: receipt(sourceKey, "video/mp4", hash), displayRect: null };
  const bundle = shared.videoPresentationVersionSchema.parse({
    schemaVersion: 1, sourceFingerprint: hash, versionId: REMOVAL_VERSION_ID, toolInputId, planSha256, policyVersion: 1, producerVersion: DIGEST, profileVersion: DIGEST,
    original: { width: plan.display.width, height: plan.display.height, duration: 5.055 }, display: { ...REMOVAL_DISPLAY, ...plan.display },
    playback, toolSource: { edit, keyframes: options.keyframes ?? REMOVAL_KEYFRAMES, sourceDecodeKey: "sdr_8bit" },
  });
  const snapshot = { sourceBinding: { storageKey: sourceKey, sourceFingerprint: hash }, presentation: bundle, preparation: null, readmit: false };
  return { presentationRef: { source: { toolInputId, planSha256 } }, versionId: REMOVAL_VERSION_ID, bundle, snapshot };
}
