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
 * ## The shape of a document Space's content
 *
 * ```
 * content
 *   ├─ title          exactly one, always first, cannot be deleted
 *   └─ …blocks        zero or more; an empty body is a legal state
 * ```
 *
 * The title is what makes the fragment safe. ProseMirror's document model
 * cannot represent a document with nothing in it, while a Yjs fragment's idea
 * of empty is nothing at all; when the two disagree the editor writes its own
 * repair into Yjs, and that repair counts as a user edit — it lands on the
 * undo stack and clears the redo the user was entitled to. A first block that
 * NOBODY can issue a delete for closes that gap by construction rather than by
 * repair: no delete operation for it exists, so no merge of concurrent edits
 * can produce one. That is also why the blocks after it are optional — once
 * the title guarantees the fragment is inhabited, requiring a body block would
 * re-open exactly the gap the title just closed.
 *
 * The title's undeletability is enforced by the editor's schema, in
 * `web/spaces/document/document-title`. Measured there against every gesture
 * that could plausibly remove it.
 *
 * ## Why the backend seeds it, and not the editor
 *
 * The editor cannot do it without three preconditions that the backend does
 * not have: it has to wait for the document to sync (seeding a title that has
 * merely not loaded yet puts one in front of the server's content), it has to
 * know whether this client may write at all (a viewer's seed is dropped by the
 * server without an error, leaving them permanently one block ahead of
 * everyone else), and it has to survive remounting when the user switches
 * Space tabs. None of the three can be got right from the browser, and the
 * guard that looks like it settles it — insert only when the fragment reads
 * empty — is a purely local read: two clients opening a brand-new Space within
 * one round trip both see zero, both insert, and Yjs keeps both.
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

/**
 * Top-level key holding a document Space's body.
 *
 * Not exported past this module: everyone reaches the fragment through
 * {@link documentBodyFragment}, which is the point — a second place naming the
 * key is a second place that can drift from it.
 */
const DOCUMENT_BODY_KEY = "content";

/**
 * Node name of the document's title block.
 *
 * Exported because the editor's schema has to register a node under exactly
 * this name; a mismatch is silent — the editor deletes what it cannot resolve.
 */
export const DOCUMENT_TITLE_NODE = "title";

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
 * structure on first bind. A document starts with the title described at the
 * top of this file and no body blocks at all.
 *
 * `name` is the Space's name — the one shown on its tab. A document Space's
 * title and its tab name start out as the same thing, on both creation paths:
 * a Space made from the new-Space dialog carries the name its creator typed,
 * and a project's first Space carries the one the backend derives from the
 * Space type. It is required rather than optional precisely because there is
 * no path without one, and an optional argument would be a branch someone
 * could forget to pass.
 *
 * They are the same only at birth. Renaming the tab afterwards does not touch
 * the title, and editing the title does not touch the tab — they live in two
 * different Yjs documents (the tab name in the project's meta document, the
 * title in this one), and syncing them would mean deciding who wins when both
 * change at once.
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
 * @param name - The Space's name, which is also the document's opening title.
 * @returns The encoded Yjs update, ready to persist as the initial state.
 */
export function encodeInitialSpaceContent(
  kind: SpaceType,
  name: string,
): Uint8Array {
  const doc = new Y.Doc();
  // Returning from inside each branch is what makes the switch exhaustive:
  // TypeScript reports a missing return path when a fourth kind is added,
  // which is the whole point. Returning after the switch compiles fine and
  // would ship the new kind an empty document with nothing to say so.
  switch (kind) {
    case "document": {
      const titleNode = new Y.XmlElement(DOCUMENT_TITLE_NODE);
      // An empty name would give the document an empty title, which is a
      // legal state the placeholder covers — but no caller has one, so it is
      // not worth a branch that no test could reach.
      if (name) titleNode.insert(0, [new Y.XmlText(name)]);
      documentBodyFragment(doc).push([titleNode]);
      return Y.encodeStateAsUpdate(doc);
    }
    case "canvas":
    case "timeline":
      return Y.encodeStateAsUpdate(doc);
  }
}
