// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { createForbiddenTokenRule } from "#rules/forbidden-token-rule";

/**
 * `yjs_documents` is shared infrastructure: collab persists documents into
 * it, and the server creates, deletes and duplicates rows when projects
 * change. Two services reaching one table directly is how the same query
 * ends up written twice and drifting, so the table has a single repo and
 * everyone else calls it.
 */
export const noYjsDocumentsOutsideRepo = createForbiddenTokenRule({
  name: "no-yjs-documents-outside-repo",
  description: "The yjs_documents table is reached only through its repo",
  tokens: ["yjs_documents", "yjsDocuments"],
  message:
    "{{token}} is reached outside its repo — call the yjs-documents repo instead. One shared table, one owner.",
});
