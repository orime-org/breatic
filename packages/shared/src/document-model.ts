// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The document body's schema definitions, which a Node process (collab)
 * shares with the browser's editor: the block specs, the marks extensions
 * bring in, and the ProseMirror schema built from them without a DOM
 * (breatic#1488 §11.1). Web attaches its views (media node views, the
 * table's scroller frame and paste rule, the stand-ins' labels) to these
 * definitions. It stays out of the main entry because it imports BlockNote.
 */

export * from "@shared/document/model/document-comment-body.js";
export * from "@shared/document/model/document-comment-mark.js";
export * from "@shared/document/model/document-list-block.js";
export * from "@shared/document/model/document-pm-schema.js";
export * from "@shared/document/model/document-schema-blocknote.js";
export * from "@shared/document/model/document-table-legacy.js";
export * from "@shared/document/model/document-table-nodes.js";
export * from "@shared/document/model/document-unsupported-blocknote.js";
