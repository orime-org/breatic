// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { z } from "zod";
import type { PendingFailureReason } from "@shared/document-upload.js";
import { durationToFrames, type TimelineRate } from "@shared/timeline/time.js";

export type { TimelineRate };

/** The frame size and frame rate of one Timeline document; the size changes with `set_frame` (#1502), the rate never. */
export interface TimelineSettings { width: number; height: number; fps: TimelineRate }

/** A track identity; tracks have no kind, so any clip goes on any track (inner#1709). */
export interface TimelineTrack { id: string; order: number }

/** A registered video, stored by its address with its media facts like a canvas node, measured in a fixed logical source timebase. */
export interface TimelineVideoSource {
  id: string;
  kind: "video";
  url: string;
  coverUrl: string | null;
  /** Shown as the clip label. */
  name: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  timebase: TimelineRate;
  extentFrames: number;
  durationSeconds: string;
  durationOrigin: "registered" | "decoded";
}

/** A registered picture, stored by its address with its media facts; it has no length of its own. */
export interface TimelineImageSource {
  id: string;
  kind: "image";
  url: string;
  /** Shown as the clip label. */
  name: string;
  mimeType: string;
  /** Null when registration measured no size; the preview then uses the decoded size. */
  width: number | null;
  height: number | null;
}

/** A registered sound, stored by its address with its media facts and measured like a video. */
export interface TimelineAudioSource {
  id: string;
  kind: "audio";
  url: string;
  /** Shown as the clip label. */
  name: string;
  mimeType: string;
  timebase: TimelineRate;
  extentFrames: number;
  durationSeconds: string;
  durationOrigin: "registered" | "decoded";
}

/** Any registered source, discriminated by `kind`. */
export type TimelineSource = TimelineVideoSource | TimelineImageSource | TimelineAudioSource;

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

/** One placement of a registered picture; its in-point is always 0. */
export interface TimelineImageClip extends Omit<TimelineVideoClip, "kind"> { kind: "image" }

/** One placement of a registered sound. */
export interface TimelineAudioClip extends Omit<TimelineVideoClip, "kind"> { kind: "audio" }

/** A text label; each copy holds its own words, and its in-point is always 0. */
export interface TimelineTextClip extends Omit<TimelineVideoClip, "kind" | "sourceId"> {
  kind: "text";
  /** `size` is the font size as a share of the frame height. */
  text: { body: string; size: number };
}

/** Which execution result a web-animation copy shows: a succeeded source version; a copy placed before Motion may bind an execution instead, or both. */
export interface TimelineWebAnimationContentBinding { baseSourceResultId: string | null; operationId: string | null }

/** One independent placement of a web-animation execution result; its content lives outside the document. */
export interface TimelineWebAnimationClip extends Omit<TimelineVideoClip, "kind" | "sourceId"> {
  kind: "web-animation";
  contentBinding: TimelineWebAnimationContentBinding;
}

/** A placeholder for a local file still uploading; collab turns it into a clip of the registered kind with the same id. */
export interface TimelineUploadClip extends Omit<TimelineVideoClip, "kind" | "sourceId"> {
  kind: "upload";
  upload: {
    uploadId: string;
    name: string;
    /** What the placeholder will become. */
    kind: "video" | "image" | "audio";
    /** The length the browser read; null for a picture. */
    durationSeconds: number | null;
    /** Written by collab once the server took the bytes or ended the upload. */
    state?: "processing" | "failed";
    failure?: PendingFailureReason;
    retryable?: boolean;
  };
}

/** Any placement on a track, discriminated by `kind`. */
export type TimelineClip = TimelineVideoClip | TimelineImageClip | TimelineAudioClip | TimelineTextClip | TimelineWebAnimationClip | TimelineUploadClip;

/**
 * The Timeline document versions readers accept; 2 stores clip offsets as fractions of the frame (#1502), 3 has tracks
 * without a kind and image, audio and text clips (inner#1709).
 */
export const TIMELINE_SCHEMA_VERSIONS = [1, 2, 3] as const;

/** The loudest a clip plays: +12 dB as a linear factor, the export renderer's own cap. */
export const TIMELINE_MAX_GAIN = 10 ** (12 / 20);

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
  /** 3 since inner#1709; version 1 and 2 documents are read the same way. */
  schemaVersion: (typeof TIMELINE_SCHEMA_VERSIONS)[number];
  settings: TimelineSettings;
  tracks: Record<string, TimelineTrack>;
  clips: Record<string, TimelineClip>;
  sources: Record<string, TimelineSource>;
}

const safeFrame = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const identity = z.uuid();

/** The rational rate carried in our persisted format. */
export const TimelineRateSchema = z.object({ num: positiveInteger, den: positiveInteger }).strict();
/** The frame size and rate; only `set_frame` changes the size after the seed, and the rate stays as seeded. */
export const TimelineSettingsSchema = z.object({ width: positiveInteger, height: positiveInteger, fps: TimelineRateSchema }).strict();
/** Stable tracks used by both the editor and its serialized snapshots; reading drops the kind older versions stored. */
export const TimelineTrackSchema = z.object({ id: z.string().min(1).max(64), order: safeFrame }).strict();

/** Every registered source's address and name, stored like a canvas node's media (inner#2171). */
const addressedSourceFields = {
  id: identity,
  url: z.string().url(),
  name: z.string().min(1).max(255),
};

const measuredSourceFields = {
  timebase: TimelineRateSchema,
  extentFrames: positiveInteger,
  durationSeconds: z.string().min(1).max(128),
  durationOrigin: z.enum(["registered", "decoded"]),
};

/**
 * Report a measured source whose duration does not conform to its extent.
 * @param source - The parsed source.
 * @param source.durationSeconds - Its measured duration.
 * @param source.timebase - Its timebase.
 * @param source.extentFrames - Its extent.
 * @param ctx - The refinement context.
 * @throws {never} Never.
 */
function conformedExtent(source: { durationSeconds: string; timebase: TimelineRate; extentFrames: number }, ctx: z.RefinementCtx): void {
  try {
    if (durationToFrames(source.durationSeconds, source.timebase) === source.extentFrames) return;
  } catch {
    // This is a schema boundary: an unusable measured duration is invalid data.
  }
  ctx.addIssue({ code: "custom", path: ["durationSeconds"], message: "Invalid conformed source extent" });
}

/** An immutable source: the registered video's address and media facts, and its measured extent (inner#2171). */
export const TimelineVideoSourceSchema = z.object({
  ...addressedSourceFields,
  kind: z.literal("video"),
  coverUrl: z.string().url().nullable(),
  mimeType: z.string().startsWith("video/"),
  width: positiveInteger.nullable(),
  height: positiveInteger.nullable(),
  ...measuredSourceFields,
}).strict().superRefine(conformedExtent);

/** A registered sound, stored by its address and measured like a video (inner#1709). */
export const TimelineAudioSourceSchema = z.object({
  ...addressedSourceFields,
  kind: z.literal("audio"),
  mimeType: z.string().startsWith("audio/"),
  ...measuredSourceFields,
}).strict().superRefine(conformedExtent);

/** A registered picture, stored by its address; its size is both measured or both null (inner#1709). */
export const TimelineImageSourceSchema = z.object({
  ...addressedSourceFields,
  kind: z.literal("image"),
  mimeType: z.string().startsWith("image/"),
  width: positiveInteger.nullable(),
  height: positiveInteger.nullable(),
}).strict().refine((source) => (source.width === null) === (source.height === null), { message: "Half-measured image size" });

/** Every source kind, discriminated by `kind`. */
export const TimelineSourceSchema = z.discriminatedUnion("kind", [TimelineVideoSourceSchema, TimelineImageSourceSchema, TimelineAudioSourceSchema]);

const placementFields = {
  id: identity,
  trackId: z.string().min(1).max(64),
  startFrame: safeFrame,
  sourceInFrame: safeFrame,
  durationFrames: positiveInteger,
  rate: TimelineRateSchema,
  gain: z.number().finite().min(0).max(TIMELINE_MAX_GAIN),
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

/** A still picture has no in-point. */
export const TimelineImageClipSchema = z.object({ ...placementFields, kind: z.literal("image"), sourceId: identity, sourceInFrame: z.literal(0) }).strict();

/** A sound placed like a video. */
export const TimelineAudioClipSchema = z.object({ ...placementFields, kind: z.literal("audio"), sourceId: identity }).strict();

/** Text is stored as typed; its font and style are the shared constants, so neither is stored. */
export const TimelineTextClipSchema = z.object({
  ...placementFields,
  kind: z.literal("text"),
  sourceInFrame: z.literal(0),
  text: z.object({ body: z.string().min(1).max(2000), size: z.number().min(0.01).max(0.5) }).strict(),
}).strict();

/** A web-animation copy; its binding names a source version, an execution, or both. */
export const TimelineWebAnimationClipSchema = z.object({
  ...placementFields,
  kind: z.literal("web-animation"),
  contentBinding: z.object({ baseSourceResultId: identity.nullable(), operationId: identity.nullable() }).strict()
    .refine((binding) => binding.baseSourceResultId !== null || binding.operationId !== null, { message: "Unbound web-animation clip" }),
}).strict();

/** Every upload failure a placeholder may name; the Record makes the list follow `PendingFailureReason`. */
const PENDING_FAILURES: Record<PendingFailureReason, true> = {
  failed: true, storageFull: true, rateLimited: true, hashUnavailable: true, unsupportedType: true, tooLarge: true,
  empty: true, unreachable: true, spaceFull: true,
};

/**
 * An upload placeholder; its range against `upload.durationSeconds` is not checked here. A picture placeholder has no
 * duration and no in-point; a video or audio one has a duration.
 */
export const TimelineUploadClipSchema = z.object({
  ...placementFields,
  kind: z.literal("upload"),
  upload: z.object({
    uploadId: identity,
    name: z.string().min(1).max(255),
    kind: z.enum(["video", "image", "audio"]),
    durationSeconds: z.number().finite().positive().nullable(),
    state: z.enum(["processing", "failed"]).optional(),
    failure: z.enum(Object.keys(PENDING_FAILURES) as [PendingFailureReason, ...PendingFailureReason[]]).optional(),
    retryable: z.boolean().optional(),
  }).strict(),
}).strict().superRefine((clip, ctx) => {
  const picture = clip.upload.kind === "image";
  if (picture !== (clip.upload.durationSeconds === null)) {
    ctx.addIssue({ code: "custom", path: ["upload", "durationSeconds"], message: "Only a picture placeholder has no duration" });
  }
  if (picture && clip.sourceInFrame !== 0) ctx.addIssue({ code: "custom", path: ["sourceInFrame"], message: "A picture placeholder has no in-point" });
});

/** Every clip kind, discriminated by `kind`. */
export const TimelineClipSchema = z.discriminatedUnion("kind", [
  TimelineVideoClipSchema, TimelineImageClipSchema, TimelineAudioClipSchema, TimelineTextClipSchema, TimelineWebAnimationClipSchema,
  TimelineUploadClipSchema,
]);

/** Our complete versioned DTO, independent of a presentation library. */
export const TimelineDocumentV1Schema: z.ZodType<TimelineDocumentV1> = z.object({
  schemaVersion: z.literal(TIMELINE_SCHEMA_VERSIONS),
  settings: TimelineSettingsSchema,
  tracks: z.record(z.string(), TimelineTrackSchema),
  clips: z.record(z.string(), TimelineClipSchema),
  sources: z.record(z.string(), TimelineSourceSchema),
}).strict();

/**
 * Whether a clip can be shown, played and edited: its track exists, and it needs no source (text, web animation,
 * placeholder) or its source record exists and is of its own kind (inner#1709).
 * @param document - The tracks and sources the clip is read against.
 * @param clip - The clip.
 * @returns Whether the clip is presentable.
 * @throws {never} Never.
 */
export function isPresentableTimelineClip(document: Pick<TimelineDocumentV1, "tracks" | "sources">, clip: TimelineClip): boolean {
  if (!Object.hasOwn(document.tracks, clip.trackId)) return false;
  if (!("sourceId" in clip)) return true;
  return Object.hasOwn(document.sources, clip.sourceId) && document.sources[clip.sourceId]?.kind === clip.kind;
}
