// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { durationToFrames } from "@shared/timeline/time.js";

/** A positive rational rate owned by the Timeline format. */
export interface TimelineRate { num: number; den: number }

/** The fixed creation viewport and frame rate of one Timeline document. */
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
  transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
}

/** A user-confirmed native edit with a stable id across save retries. */
export type TimelineEditCommand = {
  actionId: string;
  operation: "add_video";
  parameters: { source: TimelineVideoSource; clip: TimelineVideoClip };
} | {
  actionId: string;
  operation: "set_start";
  parameters: { clipId: string; startFrame: number };
};

/** The immutable effect recorded with its corresponding layout transaction. */
export type NativeEditRecord = TimelineEditCommand & {
  version: 1;
  effect: "applied" | "not_applied";
  targetClipIds: string[];
  notAppliedReason?: "target_missing" | "invalid_range" | "overlap" | "source_unavailable";
};

/** Our persisted integer-frame format, independent of any editor library. */
export interface TimelineDocumentV1 {
  schemaVersion: 1;
  settings: TimelineSettings;
  tracks: Record<string, TimelineTrack>;
  clips: Record<string, TimelineVideoClip>;
  sources: Record<string, TimelineVideoSource>;
  nativeEdits: Record<string, NativeEditRecord>;
}

const safeFrame = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const identity = z.uuid();

/** The rational rate carried in our persisted format. */
export const TimelineRateSchema = z.object({ num: positiveInteger, den: positiveInteger }).strict();
/** Creation parameters, fixed in the document after its seed is stored. */
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

/** A strict placement shape; merged-layout relationships are resolved separately. */
export const TimelineVideoClipSchema = z.object({
  id: identity,
  trackId: z.string().min(1).max(64),
  kind: z.literal("video"),
  sourceId: identity,
  startFrame: safeFrame,
  sourceInFrame: safeFrame,
  durationFrames: positiveInteger,
  rate: TimelineRateSchema,
  gain: z.number().finite().min(0),
  mute: z.boolean(),
  transform: z.object({
    x: z.number().finite(), y: z.number().finite(),
    scaleX: z.number().finite().refine((value) => value !== 0),
    scaleY: z.number().finite().refine((value) => value !== 0),
    rotation: z.number().finite(),
  }).strict(),
}).strict();

const addCommand = z.object({
  actionId: identity,
  operation: z.literal("add_video"),
  parameters: z.object({ source: TimelineVideoSourceSchema, clip: TimelineVideoClipSchema }).strict(),
}).strict();
const startCommand = z.object({
  actionId: identity,
  operation: z.literal("set_start"),
  parameters: z.object({ clipId: identity, startFrame: safeFrame }).strict(),
}).strict();

/** A normalized user-confirmed native edit. */
export const TimelineEditCommandSchema = z.discriminatedUnion("operation", [addCommand, startCommand]);

const recordFields = {
  version: z.literal(1),
  effect: z.enum(["applied", "not_applied"]),
  targetClipIds: z.array(identity).length(1),
  notAppliedReason: z.enum(["target_missing", "invalid_range", "overlap", "source_unavailable"]).optional(),
};

/** The complete immutable action receipt written with its layout transaction. */
export const NativeEditRecordSchema = z.discriminatedUnion("operation", [
  addCommand.extend(recordFields), startCommand.extend(recordFields),
]).superRefine((record, ctx) => {
  if ((record.effect === "not_applied") !== (record.notAppliedReason !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["notAppliedReason"], message: "The edit effect and reason disagree" });
  }
  const clipId = record.operation === "add_video" ? record.parameters.clip.id : record.parameters.clipId;
  if (record.targetClipIds[0] !== clipId) {
    ctx.addIssue({ code: "custom", path: ["targetClipIds"], message: "The recorded target does not match the command" });
  }
});

/** Our complete versioned DTO, independent of a presentation library. */
export const TimelineDocumentV1Schema: z.ZodType<TimelineDocumentV1> = z.object({
  schemaVersion: z.literal(1),
  settings: TimelineSettingsSchema,
  tracks: z.record(z.string(), TimelineTrackSchema),
  clips: z.record(z.string(), TimelineVideoClipSchema),
  sources: z.record(z.string(), TimelineVideoSourceSchema),
  nativeEdits: z.record(z.string(), NativeEditRecordSchema),
}).strict();
