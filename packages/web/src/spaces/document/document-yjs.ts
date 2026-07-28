// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The layout of a document Space's Yjs document.
 *
 * One top-level key per concern, mirroring how the canvas Space splits its doc
 * into `nodesMap` / `edgesMap`. The body is an `XmlFragment` because that is
 * what the editor binds to; comments will arrive as their own top-level key
 * rather than being nested inside the body, so a comment thread never has to
 * survive the text it points at being rewritten.
 *
 * Keys are declared here and nowhere else — the frontend and any future
 * server-side reader must agree on them, and a typo in a second copy would
 * silently produce an empty document rather than an error.
 */

import type * as Y from 'yjs';

/** Top-level key holding the document body. */
export const DOCUMENT_BODY_KEY = 'content';

/**
 * Get the document's body fragment — the editor's binding target.
 * @param doc - The document Space's Y.Doc.
 * @returns The body fragment, created on first access.
 */
export function documentBodyFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(DOCUMENT_BODY_KEY);
}
