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

import * as Y from 'yjs';

/** Top-level key holding the document body. */
export const DOCUMENT_BODY_KEY = 'content';

/**
 * Origin stamped on the seeding transaction.
 *
 * Anything but a tracked origin would do — the point is that seeding is not a
 * user edit and must never land on an undo stack.
 */
const SEED_ORIGIN = 'document-body-seed';

/**
 * Get the document's body fragment — the editor's binding target.
 * @param doc - The document Space's Y.Doc.
 * @returns The body fragment, created on first access.
 */
export function documentBodyFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(DOCUMENT_BODY_KEY);
}

/**
 * Give an empty body the one paragraph ProseMirror insists on.
 *
 * ## The invariant
 *
 * **A document body always holds at least one block.** Every writer to a body —
 * this editor, the backend that creates a Space, an importer, a generator — has
 * to honour it, and a writer that CREATES a body must create it non-empty.
 *
 * ## Why
 *
 * The two layers disagree about what an empty document is: ProseMirror's schema
 * requires at least one block, a Yjs fragment's empty is nothing at all. The
 * disagreement surfaces the moment an undo removes the last of the content —
 * the editor still holds a paragraph the fragment no longer has, and the next
 * dispatch (a click, or a window regaining focus; both measured) reconciles
 * them by writing that paragraph back. That write carries the dispatch's own
 * `addToHistory` marker, so yjs reads it as a fresh local edit, clears the redo
 * stack, and syncs the deletion to everyone: the text just undone is gone for
 * good. Seeding removes the disagreement rather than reacting to it, and covers
 * every block type — paragraphs, lists, blockquotes, headings and code blocks
 * all measured restoring in full.
 *
 * ## Two conditions on calling it
 *
 * **Only once the document has synced.** Seeding a body that has merely not
 * loaded yet adds a paragraph the server's content then merges in behind,
 * leaving a stray blank line at the top of everyone's document.
 *
 * **Only from a client allowed to write.** The server drops a read-only
 * client's update without an error, leaving that client permanently one
 * paragraph ahead of everyone else.
 *
 * ## Known limitation: this does not converge across clients
 *
 * The `length > 0` guard is a purely LOCAL read. Two clients synced against the
 * same empty body each see zero and each insert; Yjs keeps both, because
 * concurrent inserts are never deduplicated. The document then opens with two
 * blank paragraphs — the same stray line, arriving from the other side.
 *
 * Reachable whenever two people open a brand-new Space within one round trip.
 * No smarter guard settles it: the fix is to move the seed to the one writer
 * that runs exactly once, the backend, at the moment it creates the Space.
 * @param doc - The document Space's Y.Doc, already synced.
 */
export function seedEmptyBody(doc: Y.Doc): void {
  const body = documentBodyFragment(doc);
  if (body.length > 0) return;
  doc.transact(() => {
    body.push([new Y.XmlElement('paragraph')]);
  }, SEED_ORIGIN);
}
