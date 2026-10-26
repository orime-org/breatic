// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { miniToolRequestSchema, type MiniToolRequest } from "@shared/mini-tools/request-schema.js";
import {
  videoToolAnalysisRefSchema,
  videoToolDraftSchema,
  type VideoToolAnalysisRef,
  type VideoToolDraftById,
} from "@shared/mini-tools/video-draft.js";

/** The planned remove-background submission, independent from container job capabilities. */
export interface MiniToolPlannedRequest {
  tool: "video.remove-bg";
  project_id: string;
  space_id: string;
  run_id: string;
  draft: VideoToolDraftById["video.remove-bg"];
  analysis_refs: VideoToolAnalysisRef[];
  outputs: { outputIndex: number; nodeId: string; recipe: { kind: "remove-bg" } }[];
}

/** The complete editable draft and exact output mapping of a video removal press. */
export const miniToolPlannedRequestSchema: z.ZodType<MiniToolPlannedRequest> = z.strictObject({
  tool: z.literal("video.remove-bg"),
  project_id: z.string().uuid(),
  space_id: z.string().uuid(),
  run_id: z.string().uuid(),
  draft: videoToolDraftSchema("video.remove-bg"),
  analysis_refs: z.array(videoToolAnalysisRefSchema),
  outputs: z.array(z.strictObject({
    outputIndex: z.number().int().nonnegative(),
    nodeId: z.string().uuid(),
    recipe: z.strictObject({ kind: z.literal("remove-bg") }),
  })),
}).superRefine((request, ctx) => {
  if (request.outputs.length !== 1 || request.outputs[0]?.outputIndex !== 0) {
    ctx.addIssue({ code: "custom", path: ["outputs"], message: "Video background removal requires exactly output zero" });
  }
  if (request.outputs.some((output) => output.nodeId === request.draft.source.nodeId)) {
    ctx.addIssue({ code: "custom", path: ["outputs"], message: "The source node cannot be an output destination" });
  }
});

/** Existing submissions retain their original public contract. */
export type MiniToolSubmission = MiniToolRequest | MiniToolPlannedRequest;

/** The admission union preserves legacy requests alongside complete planned submissions. */
export const miniToolSubmissionSchema: z.ZodType<MiniToolSubmission> = z.union([
  miniToolRequestSchema,
  miniToolPlannedRequestSchema,
]);
