// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Media understanding — ask one question about an ordered batch of media addresses.
 *
 * One way in. Getting the media and asking about it are two steps with an
 * order and a set of limits between them, and that order is part of the
 * capability rather than something each caller reassembles: the agent tool
 * and the worker's canvas tasks would otherwise each
 * carry a copy of it, and each copy would classify failures its own way.
 *
 * Everything about who to ask is an input — the model, the backend, the
 * credential and the source addresses — so this package reads no model catalog and no
 * configuration of its own.
 */

export { understandMediaAt } from "@domain/understand/understand-at.js";
export {
  longMediaOperationId,
  openLongMediaBatchOperation,
  longMediaInputDigest,
} from "@domain/understand/long-media-checkpoint.js";
export type {
  LongMediaBatchOperation,
  LongMediaBatchOperationInput,
} from "@domain/understand/long-media-checkpoint.js";
export {
  LongMediaBatchIncompleteError,
  LongMediaBatchFailureError,
  understandMediaInBatches,
} from "@domain/understand/understand-segment-batches.js";
export {
  LongMediaCancellationError,
  advanceLongMediaSegmentation,
  cancelLongMediaSegmentation,
} from "@domain/understand/long-media-segmentation.js";
export { readingLimitsUntil } from "@domain/understand/limits-until.js";
export {
  AUDIO_FORMAT_NAMES,
  IMAGE_FORMAT_NAMES,
  MediaUnavailable,
  UNDERSTAND_PINS,
  UnderstandRefused,
  VIDEO_FORMAT_NAMES,
} from "@domain/understand/types.js";
export type {
  LongMediaBatchLimits,
  LongMediaSegmentReference,
} from "@domain/understand/segment-batches.js";
export type {
  LongMediaBatchCheckpoint,
  LongMediaBatchInterval,
  LongMediaBatchStart,
  UnderstandMediaInBatchesRequest,
} from "@domain/understand/understand-segment-batches.js";
export type {
  AdvanceLongMediaSegmentationInput,
  LongMediaSegmentationProgress,
  RegisteredLongMediaSegment,
} from "@domain/understand/long-media-segmentation.js";
export type {
  Media,
  MediaKind,
  RefusalKind,
  UnavailableKind,
  UnderstandAnswer,
  UnderstandAt,
} from "@domain/understand/types.js";
