// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/** The panel tools: each has a collaborative `miniToolDraft:<id>` field (frames-split §5.5 plan shape row). */
export const VIDEO_TOOL_IDS = ["video.extract-frames", "video.split"] as const;
export type VideoToolId = typeof VIDEO_TOOL_IDS[number];
/** Every tool a planned request may name: the panel tools and the video focus crop, which has no draft field. */
export const PLANNED_VIDEO_TOOL_IDS = [...VIDEO_TOOL_IDS, "video.focus-crop"] as const;
export type PlannedVideoToolId = typeof PLANNED_VIDEO_TOOL_IDS[number];
/** The longest frozen source node name a focus crop keeps (frames-split §5.5 admission row). */
export const MAX_FOCUS_NAME = 300;

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

const gridFrame = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** A video focus crop's rectangle in P.display pixels (frames-split §5.5 admission row). */
export const focusCropRectSchema = z.strictObject({
  x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive(),
});

const commonDraftShape = {
  version: z.literal(1),
  draftId: z.string().uuid(),
  revision: z.string().uuid(),
  source: videoToolSourceRefSchema,
  inputs: z.array(videoToolInputSchema).refine((inputs) => new Set(inputs.map((input) => input.inputId)).size === inputs.length),
};

const draftSchemas = {
  // The current frame is the player's grid frame number (frames-split §4.3, §10.7).
  "video.extract-frames": z.strictObject({
    ...commonDraftShape,
    params: z.strictObject({
      mode: z.enum(["first", "last", "current"]),
      frameIndex: gridFrame,
    }),
  }),
  "video.split": z.strictObject({
    ...commonDraftShape,
    // Cuts are grid frame numbers (frames-split §10.7 split row).
    params: z.strictObject({ cuts: z.array(gridFrame), sensitivity: z.number().optional() }),
  }),
} satisfies Record<VideoToolId, z.ZodType>;

/**
 * The video focus crop's request draft (frames-split §5.5 admission row): the boxed video node as `source`, no inputs, the grid
 * frame, the crop in P.display and the source node's name cut to `MAX_FOCUS_NAME`. It is never stored on a node.
 */
export const videoFocusCropDraftSchema = z.strictObject({
  ...commonDraftShape,
  inputs: z.array(videoToolInputSchema).max(0),
  params: z.strictObject({ frameIndex: gridFrame, crop: focusCropRectSchema, sourceName: z.string().max(MAX_FOCUS_NAME) }),
});
export type VideoFocusCropDraft = z.infer<typeof videoFocusCropDraftSchema>;

export type VideoToolDraftById = { [K in VideoToolId]: z.infer<typeof draftSchemas[K]> };
const typedDraftSchemas: { [K in VideoToolId]: z.ZodType<VideoToolDraftById[K]> } = draftSchemas;
export type VideoToolDraft = VideoToolDraftById[VideoToolId];
export type VideoToolDraftFields = { [K in VideoToolId as `miniToolDraft:${K}`]?: VideoToolDraftById[K] };
export type VideoToolSourceRef = z.infer<typeof videoToolSourceRefSchema>;
export type VideoToolInput = z.infer<typeof videoToolInputSchema>;

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
