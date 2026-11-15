// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Unified presentation contracts (inner#1306; frames-split design §3.2, §3.5, §7.16).
 *
 * toolInputId = sha256(canonical(sourceFingerprint, planSha256)) changes only with the source bytes or the plan;
 * versionId adds policy, producer/profile and the carrier's actual bytes. Each stored object has one strict schema
 * and no legacy reader: the earlier descriptor, manifest, ledger, receipt and bare compact table fail to parse.
 */

import { z } from 'zod';
import { hashMiniToolValue } from '@shared/mini-tools/canonical-value.js';
import { presentationFrameCount, presentationTableSchema, type VideoPresentationTable } from '@shared/mini-tools/video-presentation-table.js';
import { videoPlanOutput } from '@shared/mini-tools/video-encode-plan.js';
import { checkPackedGeometry, pixel, rect } from '@shared/upload/video-presentation.js';
import {
  attempt, compare, editSpan, exactTime, hash, httpsUrl, positiveCount, safeTick, sourceClock, sourceRunsValid, spansValid,
} from '@shared/upload/video-source-ledger.js';
import type { ExactPresentationTime } from '@shared/upload/video-source-ledger-types.js';

const positiveTime = exactTime.refine(value => BigInt(value.numerator) > 0n, 'Expected a positive time');
const display = z.strictObject({ width: pixel, height: pixel, duration: positiveTime });
const objectReceipt = z.strictObject({
  storageKey: z.string().min(1), url: httpsUrl, etag: z.string().min(1), size: positiveCount, sha256: hash, contentType: z.string().min(1),
});
const identity = { versionId: hash, toolInputId: hash, planSha256: hash, policyVersion: positiveCount };

/** The selected presentation version (P descriptor); pending work belongs to preparation, so there is no state. */
export const videoPresentationVersionSchema = z.strictObject({
  // producerVersion and profileVersion are the versionId inputs a reuse is decided by (§3.5 P descriptor, §7.1).
  schemaVersion: z.literal(1), sourceFingerprint: hash, ...identity, producerVersion: positiveCount, profileVersion: positiveCount,
  original: z.strictObject({ width: pixel.nullable(), height: pixel.nullable(), duration: z.number().finite().positive().nullable() }),
  display,
  playback: z.discriminatedUnion('kind', [
    // displayRect is the picture inside a carrier padded to even dimensions, null when unpadded.
    z.strictObject({ kind: z.literal('native'), carrier: objectReceipt, displayRect: rect.nullable() }),
    z.strictObject({ kind: z.literal('alpha-packed'), carrier: objectReceipt, manifest: objectReceipt }),
  ]),
  // Carrier time to plan windows, frame by frame on the carrier's own ticks.
  playbackClock: presentationTableSchema,
});
/** A parsed selected presentation version. */
export type VideoPresentationVersion = z.infer<typeof videoPresentationVersionSchema>;

/** The alpha-packed manifest: the version's identity, the packed bytes and the logical rectangles. */
export const alphaPackedManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), ...identity, packed: objectReceipt, packedWidth: pixel, packedHeight: pixel, colorRect: rect, alphaRect: rect,
}).superRefine(checkPackedGeometry);
/** A parsed alpha-packed manifest. */
export type AlphaPackedManifest = z.infer<typeof alphaPackedManifestSchema>;

/**
 * Whether a manifest belongs to this alpha-packed version: same identity, the packed object is the carrier and the rectangles have the display size.
 * @param manifest - A parsed manifest.
 * @param version - A parsed version.
 * @returns Whether they match.
 * @throws {never} Never.
 */
export function alphaPackedManifestMatchesVersion(manifest: AlphaPackedManifest, version: VideoPresentationVersion): boolean {
  if (version.playback.kind !== 'alpha-packed') return false;
  const carrier = version.playback.carrier;
  const { width, height } = version.display;
  return manifest.versionId === version.versionId && manifest.toolInputId === version.toolInputId && manifest.planSha256 === version.planSha256 &&
    manifest.policyVersion === version.policyVersion &&
    (['storageKey', 'url', 'etag', 'size', 'sha256', 'contentType'] as const).every(key => manifest.packed[key] === carrier[key]) &&
    [manifest.colorRect, manifest.alphaRect].every(area => area.width === width && area.height === height);
}

const originEntry = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('source'), start: safeTick, count: positiveCount, step: safeTick }),
  z.strictObject({ kind: z.literal('derived-empty') }),
]);
const planShape = z.strictObject({
  display,
  colorMatrix: z.string().min(1),
  // The source transfer and bit depth decide the output conversion (§3.2 item 2); both enter planSha256.
  source: z.strictObject({ transfer: z.string().min(1).nullable(), bitDepth: positiveCount }),
  output: z.strictObject({ toneMap: z.enum(['none', 'sdr-bt709']), framePngBitDepth: z.union([z.literal(8), z.literal(16)]) }),
  policy: z.strictObject({ singleFrameDurationMs: positiveCount, emptyFill: z.enum(['black', 'transparent']) }),
  presentation: presentationTableSchema,
  originMapping: z.strictObject({
    timeBase: sourceClock,
    // Where presentation time 0 lies on the original timeline (the rebase amount).
    origin: exactTime.refine(value => !value.numerator.startsWith('-'), 'Expected a non-negative origin'),
    entries: z.array(originEntry).min(1),
    firstSource: z.strictObject({ supportStart: exactTime, lead: z.strictObject({ kind: z.literal('derived-lead'), start: exactTime }).nullable() }),
    lastSource: z.strictObject({
      support: z.enum(['declared', 'previous-max', 'audio-end', 'single-frame']), supportEnd: exactTime,
      hold: z.strictObject({ kind: z.literal('derived-hold'), end: exactTime }).nullable(),
    }),
  }),
  videoSpans: z.array(editSpan).min(1).nullable(),
  audioSpans: z.array(editSpan).nullable(),
  // Matroska Info.Duration, kept as a source fact.
  segmentDuration: positiveTime.nullable(),
});
/** The presentation plan of §3.2: timing, derived-rule policy values, colour matrix, display geometry and the source's output conversion, never carrier choices. */
export type VideoPresentationPlan = z.infer<typeof planShape>;

/**
 * Sign of an exact time minus a tick on a timescale.
 * @param value - An exact time.
 * @param tick - The tick.
 * @param timescale - Ticks per second.
 * @returns A value with the sign of the difference.
 * @throws {never} Never.
 */
function minusTick(value: ExactPresentationTime, tick: number, timescale: number): bigint {
  return BigInt(value.numerator) * BigInt(timescale) - BigInt(tick) * BigInt(value.denominator);
}

/**
 * The tick window of one frame of a table.
 * @param table - A valid table.
 * @param index - A frame index inside the table.
 * @returns Its start and end ticks.
 * @throws {RangeError} When the index lies outside the table.
 */
function frameTicks(table: VideoPresentationTable, index: number): [number, number] {
  for (const run of table.runs) {
    if (index < run.count) { const start = run.start + index * run.step; return [start, start + run.duration]; }
    index -= run.count;
  }
  throw new RangeError('Frame index lies outside the presentation table');
}

/**
 * Check §7.16: the table tiles [0, display.duration); one origin entry per frame, the first real and no two empties adjacent;
 * the first real frame's lead and the last real frame's support and hold agree with their windows; spans are well formed;
 * the output conversion is the one the source decides (§3.2).
 * @param value - A structurally valid plan.
 * @returns Whether every invariant holds.
 * @throws {never} Never.
 */
function planValid(value: VideoPresentationPlan): boolean {
  const { presentation: table, originMapping: map } = value;
  const output = videoPlanOutput(value.source);
  if (output.toneMap !== value.output.toneMap || output.framePngBitDepth !== value.output.framePngBitDepth) return false;
  const scale = table.timescale;
  let cursor = 0;
  for (const run of table.runs) {
    if (run.start !== cursor || (run.count > 1 && run.step !== run.duration)) return false;
    cursor = run.start + (run.count - 1) * run.step + run.duration;
  }
  const { entries, firstSource: head, lastSource: tail } = map;
  if (minusTick(value.display.duration, cursor, scale) !== 0n || entries[0]!.kind !== 'source' ||
    entries.some((entry, index) => entry.kind === 'derived-empty' && entries[index - 1]?.kind === 'derived-empty')) return false;
  const sources = entries.flatMap(entry => (entry.kind === 'source' ? [entry] : []));
  const total = entries.reduce((count, entry) => count + (entry.kind === 'source' ? entry.count : 1), 0);
  if (!sourceRunsValid(sources) || total !== presentationFrameCount(table)) return false;
  const endsReal = entries.at(-1)!.kind === 'source';
  const lastIndex = total - (endsReal ? 1 : 2);
  const [firstStart, firstEnd] = frameTicks(table, 0);
  const [lastStart, lastEnd] = frameTicks(table, lastIndex);
  const headValid = head.lead === null
    ? minusTick(head.supportStart, firstStart, scale) === 0n
    : minusTick(head.lead.start, firstStart, scale) === 0n && minusTick(head.supportStart, firstStart, scale) > 0n && minusTick(head.supportStart, firstEnd, scale) < 0n;
  const tailValid = tail.hold === null
    ? minusTick(tail.supportEnd, lastEnd, scale) === 0n
    : endsReal && minusTick(tail.hold.end, lastEnd, scale) === 0n && minusTick(tail.supportEnd, lastEnd, scale) < 0n && minusTick(tail.supportEnd, lastStart, scale) > 0n;
  return headValid && tailValid && (lastIndex !== 0 || compare(head.supportStart, tail.supportEnd) < 0n) &&
    (value.videoSpans === null || spansValid(value.videoSpans)) && (value.audioSpans === null || spansValid(value.audioSpans));
}

// A transform runs only after every field parsed, so the invariant checks see valid integers.
/** The strict plan with its §7.16 invariants. */
export const videoPresentationPlanSchema = planShape.transform((value, ctx) => {
  if (!planValid(value)) { ctx.addIssue({ code: 'custom', message: 'The plan breaks a §7.16 presentation invariant' }); return z.NEVER; }
  return value;
});

/**
 * The physical encode facts beside the plan (§3.2 item 7): each presented frame's source keyframe ordinal, the coded
 * size, every source keyframe's pts and dts (presented or not) and the stream's first packet dts, read with the edit list
 * ignored; a dts may be negative (negative CTS offsets), a pts may not. They do not change the presentation, so they stay
 * outside planSha256 and toolInputId; the receipt digest binds them.
 */
export const videoPresentationLedgerEncodingSchema = z.strictObject({
  keyframeOrdinals: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)), codedWidth: pixel, codedHeight: pixel,
  sourceKeyframes: z.array(z.strictObject({ pts: exactTime.refine((value) => !value.numerator.startsWith('-'), 'Expected a non-negative pts'), dts: exactTime })),
  firstPacketDts: exactTime,
});

/** The full ledger: the complete plan with its origin mapping and the encode facts, bound to toolInputId and planSha256. */
export const videoPresentationLedgerSchema = z.strictObject({
  schemaVersion: z.literal(2), sourceFingerprint: hash, toolInputId: hash, planSha256: hash, attempt, plan: videoPresentationPlanSchema, encoding: videoPresentationLedgerEncodingSchema,
}).superRefine((value, ctx) => {
  const frames = presentationFrameCount(value.plan.presentation);
  const ordinals = value.encoding.keyframeOrdinals;
  if (ordinals.some((ordinal, index) => ordinal >= frames || (index > 0 && ordinal <= ordinals[index - 1]!))) {
    ctx.addIssue({ code: 'custom', path: ['encoding', 'keyframeOrdinals'], message: 'Keyframes are strictly increasing presented frames' });
  }
});
/** A parsed full ledger. */
export type VideoPresentationLedger = z.infer<typeof videoPresentationLedgerSchema>;

/**
 * One keyframe flag per presented frame, the shape `planVideoEncodeChunks` takes.
 * @param ledger - A parsed full ledger.
 * @returns The flags.
 * @throws {never} Never.
 */
export function videoPresentationKeyframeFlags(ledger: VideoPresentationLedger): boolean[] {
  const flags = Array.from({ length: presentationFrameCount(ledger.plan.presentation) }, () => false);
  for (const ordinal of ledger.encoding.keyframeOrdinals) flags[ordinal] = true;
  return flags;
}

/** The receipt of the full ledger and its compact object, two separately measured objects. */
export const videoPresentationLedgerReceiptSchema = z.strictObject({
  schemaVersion: z.literal(2), sourceFingerprint: hash, toolInputId: hash, planSha256: hash, producerVersion: positiveCount, attempt,
  url: httpsUrl, etag: z.string().min(1), size: positiveCount, sha256: hash, contentType: z.literal('application/json'),
  table: z.strictObject({ url: httpsUrl, sha256: hash, size: positiveCount, contentType: z.literal('application/json'), frameCount: positiveCount }),
}).refine(value => value.table.url !== value.url, { message: 'The compact object and the full ledger are different objects' });
/** A parsed ledger receipt. */
export type VideoPresentationLedgerReceipt = z.infer<typeof videoPresentationLedgerReceiptSchema>;

/** The compact object: exactly four fields around the S1 table. */
export const videoPresentationCompactSchema = z.strictObject({ sourceFingerprint: hash, toolInputId: hash, planSha256: hash, presentation: presentationTableSchema });
/** A parsed compact envelope. */
export type VideoPresentationCompact = z.infer<typeof videoPresentationCompactSchema>;

/**
 * Project a full ledger to its compact object (§7.16); pure.
 * @param ledger - A parsed full ledger.
 * @returns The compact envelope.
 * @throws {never} Never.
 */
export function projectVideoPresentationCompact(ledger: VideoPresentationLedger): VideoPresentationCompact {
  return { sourceFingerprint: ledger.sourceFingerprint, toolInputId: ledger.toolInputId, planSha256: ledger.planSha256, presentation: ledger.plan.presentation };
}

/** An accepted execution's presentationRef: input id to the tool input it was planned against. */
export const videoPresentationRefSchema = z.record(z.string().min(1), z.strictObject({ toolInputId: hash, planSha256: hash }))
  .refine(value => Object.keys(value).length > 0, 'Expected at least one input');
/** A parsed presentationRef map. */
export type VideoPresentationRef = z.infer<typeof videoPresentationRefSchema>;

const toolInput = z.strictObject({ sourceFingerprint: hash, planSha256: hash });
const versionInput = z.strictObject({
  sourceFingerprint: hash, policyVersion: positiveCount, producerVersion: positiveCount, profileVersion: positiveCount, planSha256: hash,
  display, playback: z.strictObject({ sha256: hash, size: positiveCount, contentType: z.string().min(1) }),
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
 * The tool input identity: SHA-256 of canonical {planSha256, sourceFingerprint}.
 * @param value - The source fingerprint and plan digest.
 * @param value.sourceFingerprint - The source bytes' lowercase SHA-256.
 * @param value.planSha256 - The plan's lowercase SHA-256.
 * @returns Its lowercase digest.
 * @throws {z.ZodError} When either is not a lowercase SHA-256 or another field is present.
 */
export async function videoPresentationToolInputId(value: { sourceFingerprint: string; planSha256: string }): Promise<string> {
  return hashMiniToolValue(toolInput.parse(value));
}

/**
 * The version identity: SHA-256 of the canonical version input, never URLs, keys or the manifest.
 * @param value - Source, policy, producer, profile, plan, display and the carrier's measured bytes.
 * @returns Its lowercase digest.
 * @throws {z.ZodError} When the input is not the strict version input.
 */
export async function videoPresentationVersionId(value: z.input<typeof versionInput>): Promise<string> {
  return hashMiniToolValue(versionInput.parse(value));
}
