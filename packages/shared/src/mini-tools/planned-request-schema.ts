// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { miniToolRequestSchema, type MiniToolRequest } from "@shared/mini-tools/request-schema.js";
import { videoToolAnalysisRefSchema, videoToolDraftSchema } from "@shared/mini-tools/video-draft.js";
import { videoSourceLedgerReceiptV2Schema } from "@shared/upload/video-source-ledger.js";

const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const seconds = z.number().nonnegative();
const range = z.strictObject({ start: seconds, end: seconds }).refine((value) => value.end > value.start);
/** Public recipes contain selection facts, never container capabilities. */
export const miniToolExecutionRecipeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("remove-bg") }),
  z.strictObject({ kind: z.literal("frame"), frameIndex: index, pts: seconds }),
  z.strictObject({ kind: z.literal("segment"), range }),
]);
const common = { project_id: z.uuid(), space_id: z.uuid(), run_id: z.uuid(), analysis_refs: z.array(videoToolAnalysisRefSchema) };
const destination = { outputIndex: index, nodeId: z.uuid() };
const removal = z.strictObject({
  ...common, tool: z.literal("video.remove-bg"), draft: videoToolDraftSchema("video.remove-bg"),
  outputs: z.array(z.strictObject({ ...destination, recipe: miniToolExecutionRecipeSchema.options[0] })),
});
const frames = z.strictObject({
  ...common, tool: z.literal("video.extract-frames"), draft: videoToolDraftSchema("video.extract-frames"),
  source_ledger: videoSourceLedgerReceiptV2Schema,
  outputs: z.array(z.strictObject({ ...destination, recipe: miniToolExecutionRecipeSchema.options[1] })),
});
const split = z.strictObject({
  ...common, tool: z.literal("video.split"), draft: videoToolDraftSchema("video.split"),
  source_ledger: videoSourceLedgerReceiptV2Schema,
  outputs: z.array(z.strictObject({ ...destination, recipe: miniToolExecutionRecipeSchema.options[2] })),
});
/** Complete press-frozen drafts and ordered output mappings for planned execution. */
export const miniToolPlannedRequestSchema = z.discriminatedUnion("tool", [removal, frames, split]).superRefine((request, ctx) => {
  if (request.outputs.length === 0 || request.outputs.some((output, position) => output.outputIndex !== position)
    || (request.tool === "video.remove-bg" && request.outputs.length !== 1)) {
    ctx.addIssue({ code: "custom", path: ["outputs"], message: "A fresh execution requires its complete ordered output indices" });
  }
  if (new Set(request.outputs.map((output) => output.nodeId)).size !== request.outputs.length
    || request.outputs.some((output) => output.nodeId === request.draft.source.nodeId)) {
    ctx.addIssue({ code: "custom", path: ["outputs"], message: "Output destinations must be unique and distinct from the source" });
  }
});
/** A fresh planned execution, independent from legacy submissions and failed-output retries. */
export type MiniToolPlannedRequest = z.infer<typeof miniToolPlannedRequestSchema>;

/** A new execution reuses only original failed output identities, not current draft inputs. */
export const miniToolExecutionRetryRequestSchema = z.strictObject({
  tool: z.enum(["video.extract-frames", "video.split"]), project_id: z.uuid(), space_id: z.uuid(), run_id: z.uuid(),
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
