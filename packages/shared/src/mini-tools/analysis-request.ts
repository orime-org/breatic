// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { miniToolAnalysisInputSchema } from "@shared/mini-tools/analysis-input.js";
import { videoToolSourceRefSchema } from "@shared/mini-tools/video-draft.js";

/** The existing tasks lane's discriminator for analysis execution and recovery. */
export const MINI_TOOL_ANALYSIS_JOB = "execute-mini-tool-analysis";

const requestIdentity = {
  analysisRunId: z.string().uuid(), projectId: z.string().uuid(), spaceId: z.string().uuid(),
  hostNodeId: z.string().uuid(), draftId: z.string().uuid(), revision: z.string().uuid(),
  source: videoToolSourceRefSchema, inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
};

/** Editable analysis inputs shared by the browser and admission endpoint. */
export const miniToolAnalysisRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...requestIdentity, kind: z.literal("people"), params: miniToolAnalysisInputSchema.options[0].pick({ anchor: true }) }),
  z.strictObject({ ...requestIdentity, kind: z.literal("scene_cuts"), params: miniToolAnalysisInputSchema.options[1].pick({ range: true }) }),
  z.strictObject({ ...requestIdentity, kind: z.literal("tracked_mask"), params: miniToolAnalysisInputSchema.options[2].pick({ range: true, anchor: true, region: true, trackingPrompt: true }) }),
]);

export type MiniToolAnalysisRequest = z.infer<typeof miniToolAnalysisRequestSchema>;
