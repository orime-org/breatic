// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only


export {
  attachTimelineRecord, freezeTimelineRecord, initializeTimelineDocument, readTimelineContent, readTimelineDocument, readTimelineSource, timelineRecordJson,
  timelineDocumentNeedsUpgrade, upgradeTimelineDocument,
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
export {
  MODEL_KEYS_PATH, MODEL_KEYS_TIMESTAMP_HEADER, MODEL_KEYS_SIGNATURE_HEADER, MODEL_KEYS_SEALED_TYPE, MODEL_KEYS_REFUSAL_STATUS,
  modelKeysRequestSchema, modelKeysRefusalSchema, ModelKeysUnreadable, sealModelKeys, openModelKeys, signModelKeysRequest,
  verifyModelKeysRequest,
  type ModelKeysRequest, type ModelKeysRefusal, type ModelKeysRequestCheck,
} from "@shared/upload/model-keys.js";
