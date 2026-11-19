// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";
import { miniToolRequestSchema, type MiniToolRequest } from "@shared/mini-tools/request-schema.js";
import { focusCropRectSchema, videoFocusCropDraftSchema, videoToolAnalysisRefSchema, videoToolDraftSchema } from "@shared/mini-tools/video-draft.js";

const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const range = z.strictObject({ start: index, end: index }).refine((value) => value.end > value.start);
/**
 * Public recipes contain selection facts on grid frame numbers, never container capabilities or seconds (frames-split
 * §10.8 request row): a frame is its grid frame, a video focus crop adds its rectangle in P.display (§5.5 recipe row), a segment
 * is a grid frame range [start, end).
 */
export const miniToolExecutionRecipeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("remove-bg") }),
  z.strictObject({ kind: z.literal("frame"), frameIndex: index, crop: focusCropRectSchema.optional() }),
  z.strictObject({ kind: z.literal("segment"), range }),
  z.strictObject({ kind: z.literal("transitions") }),
  z.strictObject({ kind: z.literal("lip-sync") }),
  z.strictObject({ kind: z.literal("erase") }),
  z.strictObject({ kind: z.literal("expand") }),
]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const toolInputRef = z.strictObject({ toolInputId: hash, planSha256: hash });
/** The tool input each request input was planned against (§7.11, §7.13); the single-input tools name theirs `source`. */
export const miniToolPresentationRefSchema = z.strictObject({ source: toolInputRef });
/** A single-input tool's ref. */
export type MiniToolPresentationRef = z.infer<typeof miniToolPresentationRefSchema>;
/** A multi-input tool's refs, keyed by the draft input id each clip plays (§97 D11-3). */
const inputPresentationRefSchema = z.record(z.uuid(), toolInputRef);
const common = { project_id: z.uuid(), space_id: z.uuid(), run_id: z.uuid(), analysis_refs: z.array(videoToolAnalysisRefSchema), presentation_ref: miniToolPresentationRefSchema };
const destination = { outputIndex: index, nodeId: z.uuid() };
const removal = z.strictObject({
  ...common, tool: z.literal("video.remove-bg"), draft: videoToolDraftSchema("video.remove-bg"),
  outputs: z.array(z.strictObject({ ...destination, recipe: miniToolExecutionRecipeSchema.options[0] })),
});
const frames = z.strictObject({
  ...common, tool: z.literal("video.extract-frames"), draft: videoToolDraftSchema("video.extract-frames"),
  outputs: z.array(z.strictObject({ ...destination, recipe: miniToolExecutionRecipeSchema.options[1] })),
});
// A video focus crop (§5.5 plan shape row): one output on the panel node, a frame recipe with its crop equal to the draft's.
const focusCrop = z.strictObject({
  ...common, tool: z.literal("video.focus-crop"), draft: videoFocusCropDraftSchema,
  outputs: z.array(z.strictObject({ ...destination, recipe: miniToolExecutionRecipeSchema.options[1] })),
}).refine((request) => request.outputs.every((output) => output.recipe.frameIndex === request.draft.params.frameIndex && output.recipe.crop !== undefined
  && (["x", "y", "width", "height"] as const).every((key) => output.recipe.crop![key] === request.draft.params.crop[key])), { path: ["outputs"], message: "A focus crop's recipe is its draft's frame and crop" });
const split = z.strictObject({
  ...common, tool: z.literal("video.split"), draft: videoToolDraftSchema("video.split"),
  outputs: z.array(z.strictObject({ ...destination, recipe: miniToolExecutionRecipeSchema.options[2] })),
});
// Two clips, one on the node's current video and one on the picked input, a ref per clip input and one output (§97 D11-3).
const transitions = z.strictObject({
  ...common, presentation_ref: inputPresentationRefSchema, tool: z.literal("video.transitions"), draft: videoToolDraftSchema("video.transitions"),
  outputs: z.array(z.strictObject({ ...destination, recipe: miniToolExecutionRecipeSchema.options[3] })),
}).superRefine((request, ctx) => {
  const { clips } = request.draft.params;
  const inputs = new Map(request.draft.inputs.map((input) => [input.inputId, input]));
  const held = clips.map((clip) => inputs.get(clip.inputId));
  const current = held.filter((input) => input?.sourceNodeId === request.draft.source.nodeId).length;
  if (clips.length !== 2 || held.some((input) => input === undefined) || current !== 1) {
    ctx.addIssue({ code: "custom", path: ["draft", "params", "clips"], message: "A transition joins the current video and one picked input" });
  }
  const refs = Object.keys(request.presentation_ref).sort();
  const played = [...new Set(clips.map((clip) => clip.inputId))].sort();
  if (refs.length !== played.length || refs.some((key, at) => key !== played[at])) {
    ctx.addIssue({ code: "custom", path: ["presentation_ref"], message: "Each clip input has exactly one tool input ref" });
  }
});
// One output over the node's video; the people the rows name come from the referenced people analysis (§97 D17-1).
const lipSync = z.strictObject({
  ...common, tool: z.literal("video.lip-sync"), draft: videoToolDraftSchema("video.lip-sync"),
  outputs: z.array(z.strictObject({ ...destination, recipe: miniToolExecutionRecipeSchema.options[4] })),
});
// One output over the range; the tracked mask it erases comes from the one referenced tracking analysis (§10.4).
const erase = z.strictObject({
  ...common, tool: z.literal("video.erase"), draft: videoToolDraftSchema("video.erase"),
  outputs: z.array(z.strictObject({ ...destination, recipe: miniToolExecutionRecipeSchema.options[5] })),
}).refine((request) => request.analysis_refs.length === 1 && request.analysis_refs[0]!.toolId === "video.erase", { path: ["analysis_refs"], message: "An erase names exactly one tracking analysis" });
// One output over the whole source; expand reads no analysis (§10.5).
const expand = z.strictObject({
  ...common, tool: z.literal("video.expand"), draft: videoToolDraftSchema("video.expand"),
  outputs: z.array(z.strictObject({ ...destination, recipe: miniToolExecutionRecipeSchema.options[6] })),
}).refine((request) => request.analysis_refs.length === 0, { path: ["analysis_refs"], message: "An expand names no analysis" });
/** The tools a planned run has exactly one output for. */
const SINGLE_OUTPUT = new Set(["video.remove-bg", "video.transitions", "video.lip-sync", "video.erase", "video.expand", "video.focus-crop"]);
/** Complete press-frozen drafts and ordered output mappings for planned execution. */
export const miniToolPlannedRequestSchema = z.discriminatedUnion("tool", [removal, frames, focusCrop, split, transitions, lipSync, erase, expand]).superRefine((request, ctx) => {
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
 * these, and a failed output of any other tool (transitions) is never retryable.
 */
export const MINI_TOOL_RETRY_TOOLS = ["video.remove-bg", "video.extract-frames", "video.split", "video.lip-sync", "video.erase", "video.expand"] as const;

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
