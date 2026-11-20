// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unified presentation contracts on the frame grid (inner#1306; frames-split design §3.2, §3.5, §4.1, §7.4).
 *
 * toolInputId = sha256(canonical(sourceFingerprint, planSha256, editFileSha256)) changes only with the source bytes, the
 * plan or the edit file's bytes; versionId adds policy, the producer and playback profile digests, the toolInputId, the
 * display grid and the carrier's actual bytes. Each stored object has one strict schema and no legacy reader.
 */

import { z } from 'zod';
import { hashMiniToolValue } from '@shared/mini-tools/canonical-value.js';
import { EDIT_FILE_TIERS } from '@shared/mini-tools/video-encode-plan.js';
import { SOURCE_DECODE_KEYS } from '@shared/upload/frame-grid-rate.js';
import { checkPackedGeometry, pixel, rect } from '@shared/upload/video-presentation.js';

export const positiveCount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const httpsUrl = z.url().refine(value => value.startsWith('https://'));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** A positive exact rational of safe integers, such as a frame rate. */
export const positiveRationalSchema = z.strictObject({ numerator: positiveCount, denominator: positiveCount });
/** An exact rational time in seconds of safe integers, such as the grid start in source time. */
export const rationalTimeSchema = z.strictObject({ numerator: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), denominator: positiveCount });

/**
 * P's display (§3.5 P descriptor, §4.1): the decoded first frame's square-pixel geometry and the grid — fps, the measured
 * frame count, the grid start in source time, the real video slots V and the lead and hold slots. Its duration is
 * frameCount ÷ fps and is not stored.
 */
export const videoPresentationDisplaySchema = z.strictObject({
  width: pixel, height: pixel, fps: positiveRationalSchema, frameCount: positiveCount, gridStart: rationalTimeSchema,
  realFrameCount: positiveCount, leadFrames: count, holdFrames: count,
}).refine(value => value.realFrameCount <= value.frameCount && value.holdFrames === value.frameCount - value.realFrameCount && value.leadFrames < value.realFrameCount,
  'The grid has V ≤ frameCount real slots, hold = frameCount − V and fewer lead slots than V');
/** A parsed display grid. */
export type VideoPresentationDisplay = z.infer<typeof videoPresentationDisplaySchema>;

const objectReceipt = z.strictObject({
  storageKey: z.string().min(1), url: httpsUrl, etag: z.string().min(1), size: positiveCount, sha256: hash, contentType: z.string().min(1),
});
/** The edit file's receipt (§3.5 edit-file receipt): its measured object, the edit profile digest and its tier (§4.2). */
export const videoPresentationEditReceiptSchema = objectReceipt.extend({ editProfileVersion: hash, tier: z.enum(EDIT_FILE_TIERS) });
/** A parsed edit-file receipt. */
export type VideoPresentationEditReceipt = z.infer<typeof videoPresentationEditReceiptSchema>;
/** Source keyframe statistics (§3.2 item 7), in seconds. */
export const sourceKeyframeStatsSchema = z.strictObject({
  earliestKeyframeTime: z.number().finite(), maxKeyframeInterval: z.number().finite().nonnegative(), allKeyframes: z.boolean(),
});
/**
 * The tool source of a version (§7.4): the edit file's receipt, or null when tools read the original; the source keyframe
 * statistics and the original's decode-rate key, frozen at the probe.
 */
export const videoPresentationToolSourceSchema = z.strictObject({
  edit: videoPresentationEditReceiptSchema.nullable(), keyframes: sourceKeyframeStatsSchema, sourceDecodeKey: z.enum(SOURCE_DECODE_KEYS),
});
/** A parsed tool source. */
export type VideoPresentationToolSource = z.infer<typeof videoPresentationToolSourceSchema>;

/**
 * The presentation plan of §3.2 item 2: the grid's rule inputs, the grid rules version, the tool source kind, the selected
 * audio track, the display geometry, the colour handling and the frame PNG depth; never carrier choices, URLs or hashes.
 */
export const videoPresentationPlanSchema = z.strictObject({
  gridRulesVersion: positiveCount,
  grid: z.strictObject({
    fps: positiveRationalSchema, gridStart: rationalTimeSchema, leadFrames: count, gridEnd: rationalTimeSchema.nullable(), singleFrameDurationMs: positiveCount,
  }),
  toolSource: z.enum(['original', 'edit']),
  audioTrack: count.nullable(),
  display: z.strictObject({ width: pixel, height: pixel }),
  color: z.strictObject({ matrix: z.string().min(1), toneMap: z.enum(['none', 'sdr-bt709']) }),
  framePngBitDepth: z.union([z.literal(8), z.literal(16)]),
});
/** A parsed presentation plan. */
export type VideoPresentationPlan = z.infer<typeof videoPresentationPlanSchema>;

/**
 * The selected presentation version (P descriptor, §3.5); pending work belongs to preparation, so there is no state. It
 * carries the plan object itself (§3.2 item 6), which a reader adopts only after `verifyVideoPresentationPlan`.
 */
export const videoPresentationVersionSchema = z.strictObject({
  // producerVersion and profileVersion are sha256 digests the reuse routes compare (§7.1).
  schemaVersion: z.literal(1), sourceFingerprint: hash, versionId: hash, toolInputId: hash, planSha256: hash, policyVersion: positiveCount,
  producerVersion: hash, profileVersion: hash,
  original: z.strictObject({ width: pixel.nullable(), height: pixel.nullable(), duration: z.number().finite().positive().nullable() }),
  display: videoPresentationDisplaySchema,
  plan: videoPresentationPlanSchema,
  playback: z.discriminatedUnion('kind', [
    // displayRect is the picture inside a carrier padded to even dimensions, null when unpadded.
    z.strictObject({ kind: z.literal('native'), carrier: objectReceipt, displayRect: rect.nullable() }),
    z.strictObject({ kind: z.literal('alpha-packed'), carrier: objectReceipt, manifest: objectReceipt }),
  ]),
  toolSource: videoPresentationToolSourceSchema,
});
/** A parsed selected presentation version. */
export type VideoPresentationVersion = z.infer<typeof videoPresentationVersionSchema>;

/** The alpha-packed manifest (§3.5): the packed bytes and the logical rectangles; P binds it by its measured hash. */
export const alphaPackedManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), packed: objectReceipt, packedWidth: pixel, packedHeight: pixel, colorRect: rect, alphaRect: rect,
}).superRefine(checkPackedGeometry);
/** A parsed alpha-packed manifest. */
export type AlphaPackedManifest = z.infer<typeof alphaPackedManifestSchema>;

/**
 * Whether a manifest belongs to this alpha-packed version: the packed object is the carrier and the rectangles have the display size.
 * @param manifest - A parsed manifest.
 * @param version - A parsed version.
 * @returns Whether they match.
 * @throws {never} Never.
 */
export function alphaPackedManifestMatchesVersion(manifest: AlphaPackedManifest, version: VideoPresentationVersion): boolean {
  if (version.playback.kind !== 'alpha-packed') return false;
  const carrier = version.playback.carrier;
  const { width, height } = version.display;
  return (['storageKey', 'url', 'etag', 'size', 'sha256', 'contentType'] as const).every(key => manifest.packed[key] === carrier[key]) &&
    [manifest.colorRect, manifest.alphaRect].every(area => area.width === width && area.height === height);
}

/** An accepted execution's presentationRef: input id to the tool input it was planned against. */
export const videoPresentationRefSchema = z.record(z.string().min(1), z.strictObject({ toolInputId: hash, planSha256: hash }))
  .refine(value => Object.keys(value).length > 0, 'Expected at least one input');
/** A parsed presentationRef map. */
export type VideoPresentationRef = z.infer<typeof videoPresentationRefSchema>;

const toolInput = z.strictObject({ sourceFingerprint: hash, planSha256: hash, editFileSha256: hash.nullable() });
const versionInput = z.strictObject({
  sourceFingerprint: hash, policyVersion: positiveCount, producerVersion: hash, profileVersion: hash, planSha256: hash, toolInputId: hash,
  display: videoPresentationDisplaySchema, playback: z.strictObject({ sha256: hash, size: positiveCount, contentType: z.string().min(1) }),
});

/**
 * The plan's identity: SHA-256 of the canonical strict plan.
 * @param value - The plan.
 * @returns Its lowercase digest.
 * @throws {z.ZodError} When the plan is not a valid plan.
 */
export async function videoPresentationPlanSha256(value: unknown): Promise<string> {
  return hashMiniToolValue(videoPresentationPlanSchema.parse(value));
}

/**
 * Adopt a plan only when it is the one its digest names (§3.2 item 6): sha256(canonical(plan)) must equal planSha256, the
 * check every reader of a version or a prepare answer runs where it crosses a trust boundary.
 * @param value - A parsed version, or a plan with the digest it travels under.
 * @param value.plan - The plan object.
 * @param value.planSha256 - The digest it claims.
 * @returns Nothing when the plan is the digest's.
 * @throws {Error} When the plan's canonical digest is not planSha256.
 */
export async function verifyVideoPresentationPlan(value: { plan: VideoPresentationPlan; planSha256: string }): Promise<void> {
  if (await videoPresentationPlanSha256(value.plan) !== value.planSha256) throw new Error('The presentation plan is not the one its planSha256 names');
}

/**
 * The tool input identity (§3.2 item 3): SHA-256 of canonical {sourceFingerprint, planSha256, editFileSha256}.
 * @param value - The source fingerprint, plan digest and the edit file's SHA-256 (null without an edit file).
 * @param value.sourceFingerprint - The source bytes' lowercase SHA-256.
 * @param value.planSha256 - The plan's lowercase SHA-256.
 * @param value.editFileSha256 - The measured edit file's lowercase SHA-256, or null.
 * @returns Its lowercase digest.
 * @throws {z.ZodError} When a digest is not a lowercase SHA-256 or another field is present.
 */
export async function videoPresentationToolInputId(value: { sourceFingerprint: string; planSha256: string; editFileSha256: string | null }): Promise<string> {
  return hashMiniToolValue(toolInput.parse(value));
}

/**
 * The version identity (§3.2 item 4): SHA-256 of the canonical version input, never URLs, keys or the manifest.
 * @param value - Source, policy, producer, profile, plan, toolInputId, display grid and the carrier's measured bytes.
 * @returns Its lowercase digest.
 * @throws {z.ZodError} When the input is not the strict version input.
 */
export async function videoPresentationVersionId(value: z.input<typeof versionInput>): Promise<string> {
  return hashMiniToolValue(versionInput.parse(value));
}
