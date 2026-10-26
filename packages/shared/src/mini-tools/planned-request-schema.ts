// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { miniToolRequestSchema, type MiniToolRequest } from "@shared/mini-tools/request-schema.js";
import type { VideoToolAnalysisRef, VideoToolDraftById } from "@shared/mini-tools/video-draft.js";

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

/** RED boundary: planned submissions are not admitted until their contract is implemented. */
export const miniToolPlannedRequestSchema: z.ZodType<MiniToolPlannedRequest> = z.never();

/** Existing submissions retain their original public contract. */
export type MiniToolSubmission = MiniToolRequest | MiniToolPlannedRequest;

/** The eventual admission union; the route retains its legacy schema until execution is wired. */
export const miniToolSubmissionSchema: z.ZodType<MiniToolSubmission> = z.union([
  miniToolRequestSchema,
  miniToolPlannedRequestSchema,
]);
