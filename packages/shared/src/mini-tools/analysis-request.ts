// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { miniToolAnalysisInputSchema } from "@shared/mini-tools/analysis-input.js";
import { miniToolPresentationRefSchema } from "@shared/mini-tools/planned-request-schema.js";
import { videoToolSourceRefSchema } from "@shared/mini-tools/video-draft.js";

/** The existing tasks lane's discriminator for analysis execution and recovery. */
export const MINI_TOOL_ANALYSIS_JOB = "execute-mini-tool-analysis";

const requestIdentity = {
  analysisRunId: z.string().uuid(), projectId: z.string().uuid(), spaceId: z.string().uuid(),
  hostNodeId: z.string().uuid(), draftId: z.string().uuid(), revision: z.string().uuid(),
  source: videoToolSourceRefSchema, inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // The tool input the analysis reads, as an execution names it (design §7.11 analysis admission).
  presentationRef: miniToolPresentationRefSchema,
};

/** Editable analysis inputs shared by the browser and admission endpoint. */
export const miniToolAnalysisRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...requestIdentity, kind: z.literal("people"), params: miniToolAnalysisInputSchema.options[0].pick({ anchor: true }) }),
  z.strictObject({ ...requestIdentity, kind: z.literal("scene_cuts"), params: miniToolAnalysisInputSchema.options[1].pick({ range: true }) }),
  z.strictObject({ ...requestIdentity, kind: z.literal("tracked_mask"), params: miniToolAnalysisInputSchema.options[2].pick({ range: true, anchor: true, region: true, trackingPrompt: true }) }),
]);

export type MiniToolAnalysisRequest = z.infer<typeof miniToolAnalysisRequestSchema>;
