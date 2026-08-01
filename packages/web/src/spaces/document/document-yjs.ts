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
 * The two layers disagree about what an empty document is. ProseMirror's schema
 * requires at least one block, so its empty document is a single empty
 * paragraph; a Yjs fragment's is nothing at all. Left alone, that disagreement
 * surfaces the moment an undo removes the last of the content: the editor still
 * holds a paragraph the fragment no longer has, and the next dispatch — a
 * click or a window regaining focus is enough, both measured — reconciles them
 * by writing that paragraph back. The write carries the
 * dispatch's own `addToHistory` marker, which an ordinary click never sets, so
 * yjs reads it as a fresh local edit and clears the redo stack. The undone text
 * becomes unrecoverable, and the deletion syncs to every collaborator.
 *
 * Seeding removes the disagreement instead of reacting to it: with the
 * paragraph already in the fragment, undo takes back the text and leaves the
 * paragraph, both layers agree, and nothing is ever written back. Measured
 * across paragraphs, lists, blockquotes, headings and code blocks — all five
 * restore in full, where the previous approach (refusing to delete the body's
 * last child) held only for paragraphs.
 *
 * **Call this only once the document has synced.** Seeding a body that merely
 * has not loaded yet adds a paragraph the server's real content then merges
 * behind, leaving a stray empty line at the top — measured, not theorised.
 *
 * ## The invariant this exists to hold
 *
 * **A document body always holds at least one block.** Every writer to a
 * document body — this editor, the backend that creates a Space, an importer, a
 * generator — has to honour it. A body that reaches zero blocks puts the editor
 * and the fragment into the disagreement described above, and the next click
 * repairs it destructively. It is not enough to avoid emptying the body; a
 * writer that CREATES one must create it non-empty.
 *
 * ## Known limitation: this does not converge across clients
 *
 * The `length > 0` guard below is a purely LOCAL read. Two clients that are
 * both synced against an empty body each see zero and each insert — and Yjs
 * keeps both, because concurrent inserts are never deduplicated. The document
 * then opens with two empty paragraphs: the stray blank line the sync gate was
 * built to prevent, arriving from the other side instead.
 *
 * Reachable whenever two people open a brand-new Space within the same round
 * trip. The fix is not a smarter guard — no local read can settle it — but
 * moving the seed to the one writer that runs exactly once: the backend, at the
 * moment it creates the Space. That is the next slice; this client-side seed is
 * what stands between the destructive repair and today's users until then.
 * @param doc - The document Space's Y.Doc, already synced.
 */
export function seedEmptyBody(doc: Y.Doc): void {
  const body = documentBodyFragment(doc);
  if (body.length > 0) return;
  doc.transact(() => {
    body.push([new Y.XmlElement('paragraph')]);
  }, SEED_ORIGIN);
}
