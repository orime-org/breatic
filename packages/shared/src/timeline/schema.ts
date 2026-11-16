// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";
import { durationToFrames, type TimelineRate } from "@shared/timeline/time.js";

export type { TimelineRate };

/** The frame size and frame rate of one Timeline document; the size changes with `set_frame` (#1502), the rate never. */
export interface TimelineSettings { width: number; height: number; fps: TimelineRate }

/** A track identity; presentation libraries do not own this format. */
export interface TimelineTrack { id: string; kind: "visual" | "audio"; order: number }

/** A registered video measured in a fixed logical source timebase. */
export interface TimelineVideoSource {
  id: string;
  kind: "video";
  assetId: string;
  timebase: TimelineRate;
  extentFrames: number;
  durationSeconds: string;
  durationOrigin: "registered" | "decoded";
}

/** One independent placement of a registered video. */
export interface TimelineVideoClip {
  id: string;
  trackId: string;
  kind: "video";
  sourceId: string;
  startFrame: number;
  sourceInFrame: number;
  durationFrames: number;
  rate: TimelineRate;
  gain: number;
  mute: boolean;
  transform: { frameX: number; frameY: number; scaleX: number; scaleY: number; rotation: number };
}

/** Which execution result a web-animation copy shows: a succeeded source version, an in-progress execution, or both. */
export interface TimelineWebAnimationContentBinding { baseSourceResultId: string | null; operationId: string | null }

/** One independent placement of a web-animation execution result; its content lives outside the document. */
export interface TimelineWebAnimationClip extends Omit<TimelineVideoClip, "kind" | "sourceId"> {
  kind: "web-animation";
  contentBinding: TimelineWebAnimationContentBinding;
}

/** A placeholder for a local video still uploading; it becomes a video clip with the same id once registered. */
export interface TimelineUploadClip extends Omit<TimelineVideoClip, "kind" | "sourceId"> {
  kind: "upload";
  /** The local file it stands for while the upload runs in the uploader's browser. */
  upload: { uploadId: string; name: string; durationSeconds: number };
}

/** Any placement on a track, discriminated by `kind`. */
export type TimelineClip = TimelineVideoClip | TimelineWebAnimationClip | TimelineUploadClip;

/** The record that an accepted action has landed in this document, keyed by its action id. */
export interface TimelineOperationReceipt { executionId: string; inputHash: string; landedAt: string }

/** The Timeline document versions readers accept; 2 stores clip offsets as fractions of the frame (#1502). */
export const TIMELINE_SCHEMA_VERSIONS = [1, 2] as const;

/**
 * Whether a stored `schemaVersion` is one readers accept.
 * @param value - The stored value.
 * @returns Whether it is a readable version.
 * @throws {never} Never.
 */
export function isTimelineSchemaVersion(value: unknown): value is (typeof TIMELINE_SCHEMA_VERSIONS)[number] {
  return TIMELINE_SCHEMA_VERSIONS.some((version) => version === value);
}

/** The seeded bottom visual track; it is magnetic when the editing user turns magnet on. */
export const TIMELINE_MAIN_TRACK_ID = "visual-1";

/** Our persisted integer-frame format, independent of any editor library. */
export interface TimelineDocumentV1 {
  /** 2 since #1502 stores clip offsets as fractions of the frame; a version 1 document is read the same way. */
  schemaVersion: (typeof TIMELINE_SCHEMA_VERSIONS)[number];
  settings: TimelineSettings;
  tracks: Record<string, TimelineTrack>;
  clips: Record<string, TimelineClip>;
  sources: Record<string, TimelineVideoSource>;
  operationReceipts: Record<string, TimelineOperationReceipt>;
}

const safeFrame = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const identity = z.uuid();

/** The rational rate carried in our persisted format. */
export const TimelineRateSchema = z.object({ num: positiveInteger, den: positiveInteger }).strict();
/** The frame size and rate; only `set_frame` changes the size after the seed, and the rate stays as seeded. */
export const TimelineSettingsSchema = z.object({ width: positiveInteger, height: positiveInteger, fps: TimelineRateSchema }).strict();
/** Stable tracks used by both the editor and its serialized snapshots. */
export const TimelineTrackSchema = z.object({ id: z.string().min(1).max(64), kind: z.enum(["visual", "audio"]), order: safeFrame }).strict();
/** An immutable logical source descriptor without an embedded playback URL. */
export const TimelineVideoSourceSchema = z.object({
  id: identity,
  kind: z.literal("video"),
  assetId: identity,
  timebase: TimelineRateSchema,
  extentFrames: positiveInteger,
  durationSeconds: z.string().min(1).max(128),
  durationOrigin: z.enum(["registered", "decoded"]),
}).strict().superRefine((source, ctx) => {
  try {
    if (durationToFrames(source.durationSeconds, source.timebase) === source.extentFrames) return;
  } catch {
    // This is a schema boundary: an unusable measured duration is invalid data.
  }
  ctx.addIssue({ code: "custom", path: ["durationSeconds"], message: "Invalid conformed video extent" });
});

const placementFields = {
  id: identity,
  trackId: z.string().min(1).max(64),
  startFrame: safeFrame,
  sourceInFrame: safeFrame,
  durationFrames: positiveInteger,
  rate: TimelineRateSchema,
  gain: z.number().finite().min(0),
  mute: z.boolean(),
  transform: z.object({
    frameX: z.number().finite(), frameY: z.number().finite(),
    scaleX: z.number().finite().refine((value) => value !== 0),
    scaleY: z.number().finite().refine((value) => value !== 0),
    rotation: z.number().finite(),
  }).strict(),
};

/** A strict placement shape; merged-layout relationships are resolved separately. */
export const TimelineVideoClipSchema = z.object({ ...placementFields, kind: z.literal("video"), sourceId: identity }).strict();

/** A web-animation copy; its binding names a source version, an execution, or both. */
export const TimelineWebAnimationClipSchema = z.object({
  ...placementFields,
  kind: z.literal("web-animation"),
  contentBinding: z.object({ baseSourceResultId: identity.nullable(), operationId: identity.nullable() }).strict()
    .refine((binding) => binding.baseSourceResultId !== null || binding.operationId !== null, { message: "Unbound web-animation clip" }),
}).strict();

/** An upload placeholder; its range against `upload.durationSeconds` is checked by the arrangement, not here. */
export const TimelineUploadClipSchema = z.object({
  ...placementFields,
  kind: z.literal("upload"),
  upload: z.object({ uploadId: identity, name: z.string().min(1).max(255), durationSeconds: z.number().finite().positive() }).strict(),
}).strict();

/** Every clip kind, discriminated by `kind`. */
export const TimelineClipSchema = z.discriminatedUnion("kind", [TimelineVideoClipSchema, TimelineWebAnimationClipSchema, TimelineUploadClipSchema]);

/** One landed action's receipt. */
export const TimelineOperationReceiptSchema = z.object({
  executionId: identity,
  inputHash: z.string().min(1).max(256),
  landedAt: z.iso.datetime(),
}).strict();

/** Our complete versioned DTO, independent of a presentation library. */
export const TimelineDocumentV1Schema: z.ZodType<TimelineDocumentV1> = z.object({
  schemaVersion: z.literal(TIMELINE_SCHEMA_VERSIONS),
  settings: TimelineSettingsSchema,
  tracks: z.record(z.string(), TimelineTrackSchema),
  clips: z.record(z.string(), TimelineClipSchema),
  sources: z.record(z.string(), TimelineVideoSourceSchema),
  operationReceipts: z.record(z.string(), TimelineOperationReceiptSchema),
}).strict();
