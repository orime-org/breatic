// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { miniToolRequestSchema, type MiniToolRequest } from "@shared/mini-tools/request-schema.js";
import { focusCropRectSchema, miniToolPresentationRefSchema, videoFocusCropDraftSchema, videoToolAnalysisRefSchema, videoToolDraftSchema } from "@shared/mini-tools/video-draft.js";

const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const range = z.strictObject({ start: index, end: index }).refine((value) => value.end > value.start);
/**
 * Public recipes contain selection facts on grid frame numbers, never container capabilities or seconds (frames-split
 * §10.8 request row): a frame is its grid frame, a video focus crop adds its rectangle in P.display (§5.5 recipe row), a segment
 * is a grid frame range [start, end).
 */
export const miniToolExecutionRecipeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("frame"), frameIndex: index, crop: focusCropRectSchema.optional() }),
  z.strictObject({ kind: z.literal("segment"), range }),
]);
const common = { project_id: z.uuid(), space_id: z.uuid(), run_id: z.uuid(), analysis_refs: z.array(videoToolAnalysisRefSchema), presentation_ref: miniToolPresentationRefSchema };
const destination = { outputIndex: index, nodeId: z.uuid() };
const frames = z.strictObject({
  ...common, tool: z.literal("video.extract-frames"), draft: videoToolDraftSchema("video.extract-frames"),
  outputs: z.array(z.strictObject({ ...destination, recipe: miniToolExecutionRecipeSchema.options[0] })),
});
// A video focus crop (§5.5 plan shape row): one output on the panel node, a frame recipe with its crop equal to the draft's.
const focusCrop = z.strictObject({
  ...common, tool: z.literal("video.focus-crop"), draft: videoFocusCropDraftSchema,
  outputs: z.array(z.strictObject({ ...destination, recipe: miniToolExecutionRecipeSchema.options[0] })),
}).refine((request) => request.outputs.every((output) => output.recipe.frameIndex === request.draft.params.frameIndex && output.recipe.crop !== undefined
  && (["x", "y", "width", "height"] as const).every((key) => output.recipe.crop![key] === request.draft.params.crop[key])), { path: ["outputs"], message: "A focus crop's recipe is its draft's frame and crop" });
const split = z.strictObject({
  ...common, tool: z.literal("video.split"), draft: videoToolDraftSchema("video.split"),
  outputs: z.array(z.strictObject({ ...destination, recipe: miniToolExecutionRecipeSchema.options[1] })),
});
/** The tools a planned run has exactly one output for. */
const SINGLE_OUTPUT = new Set(["video.focus-crop"]);
/** Complete press-frozen drafts and ordered output mappings for planned execution. */
export const miniToolPlannedRequestSchema = z.discriminatedUnion("tool", [frames, focusCrop, split]).superRefine((request, ctx) => {
  if (request.outputs.length === 0 || request.outputs.some((output, position) => output.outputIndex !== position)
    || (SINGLE_OUTPUT.has(request.tool) && request.outputs.length !== 1)) {
    ctx.addIssue({ code: "custom", path: ["outputs"], message: "A fresh execution requires its complete ordered output indices" });
  }
  if (new Set(request.outputs.map((output) => output.nodeId)).size !== request.outputs.length
    || request.outputs.some((output) => output.nodeId === request.draft.source.nodeId)) {
    ctx.addIssue({ code: "custom", path: ["outputs"], message: "Output destinations must be unique and distinct from the source" });
  }
});
/** A fresh planned execution, independent from legacy submissions and failed-output retries. */
export type MiniToolPlannedRequest = z.infer<typeof miniToolPlannedRequestSchema>;

/**
 * The planned tools whose failed output can be retried (frames-split §7.15 end of retryability): the retry request takes exactly
 * these, and a failed output of any other tool is never retryable.
 */
export const MINI_TOOL_RETRY_TOOLS = ["video.extract-frames", "video.split"] as const;

/** A new execution reuses only original failed output identities, not current draft inputs. */
export const miniToolExecutionRetryRequestSchema = z.strictObject({
  tool: z.enum(MINI_TOOL_RETRY_TOOLS), project_id: z.uuid(), space_id: z.uuid(), run_id: z.uuid(),
  retry: z.strictObject({ runId: z.uuid(), outputIndexes: z.array(index).min(1).refine((ids) => new Set(ids).size === ids.length) }),
}).refine((request) => request.run_id !== request.retry.runId, { message: "A retry requires a new execution identity" });
export type MiniToolExecutionRetryRequest = z.infer<typeof miniToolExecutionRetryRequestSchema>;
/** The two planned admission forms share the same original HTTP entry. */
export const miniToolExecutionRequestSchema = z.union([miniToolPlannedRequestSchema, miniToolExecutionRetryRequestSchema]);
export type MiniToolExecutionRequest = z.infer<typeof miniToolExecutionRequestSchema>;
/** Existing submissions retain their original public contract. */
export type MiniToolSubmission = MiniToolRequest | MiniToolExecutionRequest;
/** The admission union preserves legacy requests alongside complete planned submissions. */
export const miniToolSubmissionSchema: z.ZodType<MiniToolSubmission> = z.union([miniToolRequestSchema, miniToolExecutionRequestSchema]);
