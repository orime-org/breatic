// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The tool input an accepted run or analysis freezes (inner#1306 frames-split design §7.11): its presentation reference and
 * the selected version, whose display grid, tool source and source keyframe statistics the runner reads.
 */
import { createHash } from "node:crypto";
import { videoPresentationVersionSchema, type VideoPresentationPlan, type VideoPresentationVersion } from "@breatic/shared";
import { canonicalMiniToolValue } from "@breatic/shared/mini-tools";

const TOOL_INPUT = "e989392b50af768e7d1a42bdf29921f364c87e90bdb34ddc633209ffe22a19ec";

/**
 * The plan's digest (§3.2 item 2): SHA-256 of its canonical text, as `videoPresentationPlanSha256` computes it.
 * @param plan - The plan.
 * @returns The lowercase digest.
 */
export function planDigest(plan: VideoPresentationPlan): string {
  return createHash("sha256").update(canonicalMiniToolValue(plan)).digest("hex");
}
const receipt = (storageKey: string, sha: string): { storageKey: string; url: string; etag: string; size: number; sha256: string; contentType: string } => ({
  storageKey, url: `https://assets.test.invalid/${storageKey}`, etag: "etag", size: 1024, sha256: sha.repeat(64), contentType: "video/mp4",
});

/** What a test changes of the default 320x180, 25 fps, 96-frame opaque version read from its original. */
export interface VersionFields {
  width?: number; height?: number; frameCount?: number; fps?: { numerator: number; denominator: number };
  gridStart?: { numerator: number; denominator: number };
  /** An edit file's storage key: the version's tools read it instead of the original (§7.16). */
  editKey?: string;
  transparent?: boolean;
  /** The plan's colour handling and frame PNG depth (§3.2 item 2). */
  color?: VideoPresentationPlan["color"];
  framePngBitDepth?: 8 | 16;
}

/**
 * The plan a version of these fields carries.
 * @param fields - What differs from the default.
 * @returns The plan.
 */
export function frozenPlan(fields: VersionFields = {}): VideoPresentationPlan {
  return {
    gridRulesVersion: 1,
    grid: { fps: fields.fps ?? { numerator: 25, denominator: 1 }, gridStart: fields.gridStart ?? { numerator: 0, denominator: 1 }, leadFrames: 0, gridEnd: null, singleFrameDurationMs: 5000 },
    toolSource: fields.editKey === undefined ? "original" : "edit", audioTrack: 0, display: { width: fields.width ?? 320, height: fields.height ?? 180 },
    color: fields.color ?? { matrix: "bt709", toneMap: "none" }, framePngBitDepth: fields.framePngBitDepth ?? 8,
  };
}

/**
 * A selected version as the shared schema accepts it.
 * @param fields - What differs from the default.
 * @returns The parsed version.
 */
export function frozenVersion(fields: VersionFields = {}): VideoPresentationVersion {
  const width = fields.width ?? 320;
  const height = fields.height ?? 180;
  const frameCount = fields.frameCount ?? 96;
  const carrier = receipt("video/carrier.mp4", "c");
  const plan = frozenPlan(fields);
  return videoPresentationVersionSchema.parse({
    schemaVersion: 1, sourceFingerprint: "b".repeat(64), versionId: "e".repeat(64), toolInputId: TOOL_INPUT, planSha256: planDigest(plan), plan, policyVersion: 1,
    producerVersion: "1".repeat(64), profileVersion: "2".repeat(64), original: { width, height, duration: frameCount / 25 },
    display: { width, height, fps: fields.fps ?? { numerator: 25, denominator: 1 }, frameCount, gridStart: fields.gridStart ?? { numerator: 0, denominator: 1 },
      realFrameCount: frameCount, leadFrames: 0, holdFrames: 0 },
    playback: fields.transparent === true
      ? { kind: "alpha-packed", carrier, manifest: { ...receipt("video/manifest.json", "d"), contentType: "application/json" } }
      : { kind: "native", carrier, displayRect: null },
    toolSource: {
      edit: fields.editKey === undefined ? null : { ...receipt(fields.editKey, "f"), editProfileVersion: "3".repeat(64), tier: "edit_h264_intra_8bit_420" },
      keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1.92, allKeyframes: false }, sourceDecodeKey: "sdr_8bit",
    },
  });
}

/** The default frozen tool input of one source. */
export const FROZEN_PRESENTATION = {
  presentationRef: { source: { toolInputId: TOOL_INPUT, planSha256: planDigest(frozenPlan()) } },
  presentations: { source: frozenVersion() },
  versionIds: { source: "e".repeat(64) },
};

/** The default fixture plan's colour and PNG depth, as `planColorOf` reads them from a frozen version. */
export const PLAN_COLOR = { colorMatrix: "bt709", toneMap: "none" as const, pngBitDepth: 8 as const };
