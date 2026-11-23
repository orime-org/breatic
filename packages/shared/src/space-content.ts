// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0


export {
  attachTimelineRecord, freezeTimelineRecord, initializeTimelineDocument, readTimelineContent, readTimelineDocument, readTimelineSource, timelineRecordJson,
  timelineDocumentNeedsUpgrade, upgradeTimelineDocument,
  type TimelineDamagedRecords,
} from "@shared/timeline/document.js";
export { readSpaceMediaReferences, type SpaceMediaReferences } from "@shared/space-media-references.js";
export {
  WEB_ANIMATION_RUNTIME, WebAnimationManifestSchema, matchWebAnimationManifest, encodePreviewToken, decodePreviewToken,
  webAnimationDurationFrames, WEB_ANIMATION_MANIFEST_MAX_BYTES,
  WEB_ANIMATION_FAILED_STATUSES, WEB_ANIMATION_OPEN_STATUSES,
  webAnimationExecutionFailed, WebAnimationAspectSchema, WebAnimationExecutionRequestSchema,
  executionInputOf, WebAnimationRowViewSchema, readWebAnimationAnchor, anchorTimeWithin,
  WebAnimationListGroupSchema, WebAnimationListScopeSchema,
  type WebAnimationManifest, type WebAnimationExpectation, type WebAnimationManifestMismatch,
  type WebAnimationExecutionRequest, type WebAnimationExecutionInput,
  type WebAnimationRowView, type WebAnimationAnchor, type WebAnimationAspect,
  type WebAnimationListGroup, type WebAnimationListScope, type WebAnimationListPage,
} from "@shared/timeline/web-animation.js";
export {
  WEB_ANIMATION_CONTAINER_CLASS, WEB_ANIMATION_RENDER_CONTAINER_CLASS, webAnimationJobRequestSchema, webAnimationJobCancelSchema,
  webAnimationJobReportSchema, webAnimationRenderJobRequestSchema, webAnimationRenderJobReportSchema,
  type WebAnimationJobRequest, type WebAnimationJobCancel, type WebAnimationJobReport, type WebAnimationJobCall,
  type WebAnimationRenderJobRequest, type WebAnimationRenderJobReport,
} from "@shared/upload/web-animation-job.js";
export { WEB_ANIMATION_BRIDGE_SCRIPT } from "@shared/timeline/web-animation-bridge.js";
