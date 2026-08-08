// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The layout of a Space's content Yjs document, and the encoder that gives a
 * fresh one its initial state.
 *
 * This lives in shared because both ends consume it. The backend writes the
 * initial state when a Space is created; the editor in the browser binds to
 * the same fragment under the same key. Two copies of that agreement would
 * drift silently — the backend would keep writing to a key nobody reads, and
 * every new document would open blank with nothing to report.
 *
 * ## The invariant this file exists to hold
 *
 * **A document Space's body always holds at least one block.**
 *
 * ProseMirror's schema requires a document to have at least one block; a Yjs
 * fragment's idea of empty is nothing at all. While the two agree, nothing
 * happens. They stop agreeing the moment an undo removes the last of the
 * content: the editor still holds a paragraph the fragment no longer has, and
 * the next dispatch — a click, or the window regaining focus, both measured —
 * reconciles them by writing that paragraph back. That write carries the
 * dispatch's own `addToHistory` marker, so yjs reads it as a fresh local edit,
 * clears the redo stack, and syncs the deletion to everyone. The text just
 * undone is gone for good.
 *
 * Seeding the body at birth removes the disagreement instead of reacting to
 * it. It holds for whatever the body later contains, because the invariant is
 * about the body being non-empty, not about what kind of block is in it.
 *
 * **Every writer that empties a body has to put a block back.** Restoring a
 * saved version and generating content both clear the body before writing;
 * either one that stops short of a single block brings the bug back, and worse
 * than before — every client online at that moment writes its own paragraph
 * back, so they each lose a redo and the document ends up with one blank
 * paragraph per person.
 *
 * ## Why the backend seeds it, and not the editor
 *
 * The editor cannot do it without three preconditions that the backend does
 * not have: it has to wait for the document to sync (seeding a body that has
 * merely not loaded yet puts a paragraph in front of the server's content), it
 * has to know whether this client may write at all (a viewer's seed is dropped
 * by the server without an error, leaving them permanently one paragraph ahead
 * of everyone else), and it has to survive remounting when the user switches
 * Space tabs. None of the three can be got right from the browser, and the
 * guard that looks like it settles it — insert only when the body reads empty
 * — is a purely local read: two clients opening a brand-new Space within one
 * round trip both see zero, both insert, and Yjs keeps both.
 *
 * The backend runs exactly once, before any client connects, so all three
 * preconditions dissolve. Its write is also not on anyone's undo stack: a
 * `Y.UndoManager` only tracks the origins it is told to, and the seed happens
 * before there is a client to have one.
 *
 * ## What this makes the backend responsible for
 *
 * Writing these bytes makes the backend a producer of ProseMirror content
 * without going through ProseMirror's schema. Get the node name, the
 * attributes, or the fragment key wrong and the first client to connect will
 * not error — it will quietly repair the difference by deleting what it does
 * not recognise, and broadcast that deletion as its own edit. The contract
 * tests on both sides of this module exist for that reason, and they are
 * anchored here so neither end can be checked against a copy of itself.
 */

import * as Y from "yjs";

import type { SpaceType } from "@shared/types/space.js";

/** Top-level key holding a document Space's body. */
export const DOCUMENT_BODY_KEY = "content";

/**
 * Get a document Space's body fragment — what the editor binds to.
 * @param doc - The document Space's Y.Doc.
 * @returns The body fragment, created on first access.
 */
export function documentBodyFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(DOCUMENT_BODY_KEY);
}

/**
 * Encode the initial state for a fresh Space's content document.
 *
 * A canvas and a timeline start with nothing — their editors build their own
 * structure on first bind. A document starts with the one empty paragraph
 * described at the top of this file.
 *
 * The bytes need not be identical across calls. The row is written with
 * `ON CONFLICT DO NOTHING`, so concurrent first-seeds converge by document
 * name and the loser re-fetches the winner's bytes rather than comparing them.
 * That is also why the `clientID` is left as yjs assigns it: pinning it would
 * make two seeds from different releases merge into one block instead of two,
 * and which block survived would depend on arrival order, with both sides
 * believing they had the whole story. Two blocks is visible and fixable; a
 * silent divergence is neither.
 * @param kind - The kind of Space this content document belongs to.
 * @returns The encoded Yjs update, ready to persist as the initial state.
 */
export function encodeInitialSpaceContent(kind: SpaceType): Uint8Array {
  const doc = new Y.Doc();
  if (kind === "document") {
    documentBodyFragment(doc).push([new Y.XmlElement("paragraph")]);
  }
  return Y.encodeStateAsUpdate(doc);
}
