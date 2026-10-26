// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

export {
  BODY_OPERATION_META,
  BODY_TRACE_MARK,
  BodyProvenanceError,
  bodyOperations,
  bodyInlineOccurrences,
  recordBodyOperation,
  rebaseBodyOperation,
  transferBodyOperations,
} from '@web/spaces/document/document-body-provenance-meta';
export type {
  BodyBoundary,
  BodyHandoff,
  BodyInlineOccurrence,
  BodyInlineUnit,
  BodyOperationRebase,
  BodyTransferOperation,
  BodyTransferRange,
  BodyUnitOrigin,
} from '@web/spaces/document/document-body-provenance-meta';
export {
  BodyOriginMirror,
  auditBodyMirrorSchema,
} from '@web/spaces/document/document-body-origin-mirror';
export type {
  BodyMirrorSchemaAudit,
  BodyNativeCommand,
  BodyOriginMirrorOptions,
} from '@web/spaces/document/document-body-origin-mirror';
