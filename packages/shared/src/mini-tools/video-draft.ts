// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";
import { VIDEO_TOOL_SYNC_MODES } from "@shared/mini-tools/lipsync-timeline.js";
import { miniToolAnalysisInputSchema, miniToolAnchorSchema } from "@shared/mini-tools/analysis-input.js";

export const VIDEO_TOOL_IDS = ["video.expand", "video.erase", "video.lip-sync", "video.remove-bg", "video.extract-frames", "video.transitions", "video.split"] as const;
export type VideoToolId = typeof VIDEO_TOOL_IDS[number];

const mediaInfoShape = {
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  duration: z.number().positive(),
  mimeType: z.string().min(1),
};

export const videoToolSourceRefSchema = z.strictObject({
  nodeId: z.string().uuid(),
  canonicalURL: z.string().url(),
  mediaInfo: z.strictObject(mediaInfoShape),
});

export const videoToolInputSchema = z.strictObject({
  inputId: z.string().uuid(),
  url: z.string().url(),
  cover: z.string().url().optional(),
  mediaInfo: z.strictObject(mediaInfoShape).partial().optional(),
  sourceNodeId: z.string().uuid().optional(),
});

export const videoToolExpansionFrameSchema = z.strictObject({
  x: z.number().nonpositive(),
  y: z.number().nonpositive(),
  width: z.number().min(1),
  height: z.number().min(1),
}).refine((frame) => frame.x + frame.width >= 1 && frame.y + frame.height >= 1);

export const videoToolSyncModeSchema = z.enum(VIDEO_TOOL_SYNC_MODES);

export const videoToolDialogueRowSchema = z.strictObject({
  dialogueId: z.string().uuid(),
  personId: z.string().min(1).nullable(),
  analysisRunId: z.string().uuid().nullable(),
  audioInputId: z.string().uuid().nullable(),
  startTime: z.number().nonnegative(),
});

export const videoToolTimelineClipSchema = z.strictObject({
  clipId: z.string().uuid(),
  inputId: z.string().uuid(),
  in: z.number().nonnegative(),
  out: z.number().positive(),
  transition: z.strictObject({
    kind: z.enum(["cut", "fade", "wipeLeft", "wipeRight"]),
    duration: z.number().nonnegative(),
  }),
}).refine((clip) => clip.out > clip.in);

const commonDraftShape = {
  version: z.literal(1),
  draftId: z.string().uuid(),
  revision: z.string().uuid(),
  source: videoToolSourceRefSchema,
  inputs: z.array(videoToolInputSchema).refine((inputs) => new Set(inputs.map((input) => input.inputId)).size === inputs.length),
};

const draftSchemas = {
  "video.expand": z.strictObject({
    ...commonDraftShape,
    params: z.strictObject({
      frame: videoToolExpansionFrameSchema,
      ratio: z.enum(["free", "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"]),
      prompt: z.string(),
    }),
  }),
  "video.erase": z.strictObject({
    ...commonDraftShape,
    params: z.strictObject({
      range: miniToolAnalysisInputSchema.options[2].shape.range,
      anchor: miniToolAnchorSchema,
      region: miniToolAnalysisInputSchema.options[2].shape.region,
      trackingPrompt: z.string(),
    }),
  }),
  "video.lip-sync": z.strictObject({
    ...commonDraftShape,
    params: z.strictObject({
      anchor: miniToolAnchorSchema,
      dialogues: z.array(videoToolDialogueRowSchema).refine((rows) => new Set(rows.map((row) => row.dialogueId)).size === rows.length),
      syncMode: videoToolSyncModeSchema,
      // The selected lip-sync model (execution design §9.3); a draft without one runs the configured default.
      modelId: z.string().min(1).optional(),
    }),
  }),
  "video.remove-bg": z.strictObject({ ...commonDraftShape, params: z.strictObject({}) }),
  "video.extract-frames": z.strictObject({
    ...commonDraftShape,
    params: z.strictObject({
      mode: z.enum(["first", "last", "current"]),
      currentTime: z.number().nonnegative(),
    }),
  }),
  "video.transitions": z.strictObject({
    ...commonDraftShape,
    params: z.strictObject({
      clips: z.array(videoToolTimelineClipSchema).refine((clips) => new Set(clips.map((clip) => clip.clipId)).size === clips.length),
    }),
  }),
  "video.split": z.strictObject({
    ...commonDraftShape,
    params: z.strictObject({ cuts: z.array(z.number().nonnegative()), sensitivity: z.number().optional() }),
  }),
} satisfies Record<VideoToolId, z.ZodType>;

export type VideoToolDraftById = { [K in VideoToolId]: z.infer<typeof draftSchemas[K]> };
const typedDraftSchemas: { [K in VideoToolId]: z.ZodType<VideoToolDraftById[K]> } = draftSchemas;
export type VideoToolDraft = VideoToolDraftById[VideoToolId];
export type VideoToolDraftFields = { [K in VideoToolId as `miniToolDraft:${K}`]?: VideoToolDraftById[K] };
export type VideoToolSourceRef = z.infer<typeof videoToolSourceRefSchema>;
export type VideoToolInput = z.infer<typeof videoToolInputSchema>;
export type VideoToolExpansionFrame = z.infer<typeof videoToolExpansionFrameSchema>;
export type VideoToolDialogueRow = z.infer<typeof videoToolDialogueRowSchema>;
export type VideoToolSyncMode = z.infer<typeof videoToolSyncModeSchema>;
export type VideoToolTimelineClip = z.infer<typeof videoToolTimelineClipSchema>;

export type VideoToolDraftReading<K extends VideoToolId = VideoToolId> =
  | { state: "absent" }
  | { state: "supported"; draft: VideoToolDraftById[K] }
  | { state: "unsupported" | "invalid"; value: unknown };

/**
 * Returns the schema of one tool's atomic parameter snapshot.
 * @param toolId - A supported video tool.
 * @returns Its source, parameters and copied inputs schema.
 * @throws {never} Never.
 */
export function videoToolDraftSchema<K extends VideoToolId>(toolId: K): z.ZodType<VideoToolDraftById[K]> {
  return typedDraftSchemas[toolId];
}

/**
 * Classifies persisted data while retaining unsupported values for explicit rebuild.
 * @param toolId - The tool whose scalar is being read.
 * @param value - Its stored raw value.
 * @returns A supported draft or its original reading state.
 * @throws {never} Never.
 */
export function readVideoToolDraft<K extends VideoToolId>(toolId: K, value: unknown): VideoToolDraftReading<K> {
  if (value === undefined) return { state: "absent" };
  if (value !== null && typeof value === "object" && "version" in value && typeof value.version === "number" && Number.isInteger(value.version) && value.version !== 1) return { state: "unsupported", value };
  const parsed = videoToolDraftSchema(toolId).safeParse(value);
  return parsed.success ? { state: "supported", draft: parsed.data } : { state: "invalid", value };
}

/**
 * Lists registered source and copied-input addresses in stable encounter order.
 * @param draft - A validated draft snapshot.
 * @returns Its unique media and cover URLs.
 * @throws {never} Never.
 */
export function videoToolDraftAssetUrls(draft: VideoToolDraft): string[] {
  return [...new Set([draft.source.canonicalURL, ...draft.inputs.flatMap((input) => input.cover === undefined ? [input.url] : [input.url, input.cover])])];
}

const referenceIdentity = { version: z.literal(1), draftId: z.string().uuid(), analysisRunId: z.string().uuid(), inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/) };

export const videoToolAnalysisRefSchema = z.discriminatedUnion("toolId", [
  z.strictObject({ ...referenceIdentity, toolId: z.literal("video.erase"), kind: z.literal("tracked_mask") }),
  z.strictObject({ ...referenceIdentity, toolId: z.literal("video.lip-sync"), kind: z.literal("people") }),
  z.strictObject({ ...referenceIdentity, toolId: z.literal("video.split"), kind: z.literal("scene_cuts") }),
]);
export type VideoToolAnalysisRef = z.infer<typeof videoToolAnalysisRefSchema>;

/**
 * Reads independently accepted analysis references from a raw node-data snapshot.
 * @param data - The node's scalar data fields.
 * @returns Valid references whose run keys match their stored identities.
 * @throws {never} Never.
 */
export function videoToolAnalysisRefs(data: Readonly<Record<string, unknown>>): VideoToolAnalysisRef[] {
  const references: VideoToolAnalysisRef[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith("miniToolAnalysis:")) continue;
    const parsed = videoToolAnalysisRefSchema.safeParse(value);
    if (parsed.success && key === `miniToolAnalysis:${parsed.data.analysisRunId}`) references.push(parsed.data);
  }
  return references;
}
