// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0


export {
  attachTimelineRecord, freezeTimelineRecord, initializeTimelineDocument, readTimelineContent, readTimelineDocument, readTimelineSource, timelineRecordJson,
  type TimelineDamagedRecords,
} from "@shared/timeline/document.js";
export { readSpaceMediaReferences, type SpaceMediaReferences } from "@shared/space-media-references.js";
export {
  WEB_ANIMATION_RUNTIME, WebAnimationManifestSchema, matchWebAnimationManifest, TimelineExecutionCreateInputSchema,
  encodePreviewToken, decodePreviewToken, TimelineExecutionInputSchema, webAnimationDurationFrames, WEB_ANIMATION_MANIFEST_MAX_BYTES,
  TimelineExecutionStatusSchema, timelineExecutionEnded, timelineExecutionFailed,
  type WebAnimationManifest, type WebAnimationExpectation, type WebAnimationManifestMismatch, type TimelineExecutionCreateInput,
  type TimelineExecutionInput,
} from "@shared/timeline/web-animation.js";
export {
  WEB_ANIMATION_CONTAINER_CLASS, webAnimationJobRequestSchema, webAnimationJobCancelSchema, webAnimationJobReportSchema,
  type WebAnimationJobRequest, type WebAnimationJobCancel, type WebAnimationJobReport, type WebAnimationJobCall,
} from "@shared/upload/web-animation-job.js";
export { WEB_ANIMATION_BRIDGE_SCRIPT } from "@shared/timeline/web-animation-bridge.js";
