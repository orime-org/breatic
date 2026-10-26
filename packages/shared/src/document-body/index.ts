// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Native document-body operations load with the Project page, independently of the protocol barrel. */
export { bodyTreeOrderBetween } from "@shared/document-body-tree-vendor.js";

export {
  bodyTreeDependencies,
  bodyTreeRecordProperties,
  bodyTreeSourcePoint,
  planBodyJoin,
  planBodyRangeMove,
  planBodyReparent,
  planBodySplit,
  readBodyTree,
} from "@shared/document-body-tree.js";

export {
  documentBodyFragment,
  documentCommentThreads,
  encodeInitialSpaceContent,
} from "@shared/document-body.js";

export { importCurrentDocumentBody } from "@shared/document-body-import.js";

export { convertLegacyTables, hasLegacyTable, LEGACY_TABLE_CONVERSION_ORIGIN } from "@shared/document-body-legacy-tables.js";

export {
  assertBodySourceBoundary,
  bodyCutId,
  BODY_CONTEXT_ATTRIBUTE,
  BODY_MARK_ATTRIBUTE_PREFIX,
  BODY_REGISTRATION_ORIGIN,
  documentBodyRecords,
  documentBodySource,
  DocumentBodyFormatError,
  DOCUMENT_BODY_FORMAT,
  DOCUMENT_BODY_FORMAT_VERSION,
  readDocumentBodyRecords,
  registerBodyCut,
  registerDocumentBodyRecords,
  seedDocumentBodyRecords,
} from "@shared/document-body-records.js";
