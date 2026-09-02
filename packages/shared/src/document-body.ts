// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 *   └─ blockGroup           exactly one at the top
 *        └─ blockContainer  one per block, carrying its id
 *             └─ …content   the block's own node: paragraph, heading, …
 * ```
 *
 * There is no title block. The document's only name is the Space's name on
 * its tab, held in the project's meta document — one name, one home. A user
 * who wants a visual heading writes one.
 *
 * A fresh document is seeded with one empty paragraph rather than left empty.
 * Both hazards here were measured. Under a schema that demanded content and
 * an empty fragment (2026-08-16), two clients opening the same fresh document
 * each papered over the gap locally and one keystroke on each side merged
 * into two paragraphs nobody wrote together. Leaving the fragment empty under
 * this schema (2026-09-02) reproduces it a level up: each client fills the
 * top-level group itself, the merge yields two of them where the schema
 * allows one, and the next client to connect deletes one and broadcasts that
 * deletion as its own edit. Seeding one block leaves nothing for either side
 * to invent, so what merges is only what users actually did.
 *
 * The selection ruling, the empty-state interaction and the select-all tiers
 * that sit on top of this shape are the editor's business — the decision
 * record lives in the private engineering repo (document structure DD,
 * 2026-08-17).
 */

import { v4 as uuidv4 } from "uuid";
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
 * Get a document Space's body fragment — what the editor binds to.
 * @param doc - The document Space's Y.Doc.
 * @returns The body fragment, created on first access.
 */
export function documentBodyFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(DOCUMENT_BODY_KEY);
}

/**
 * Build the one block a fresh document Space starts with.
 *
 * Node names are camelCase because that is what the editor registers them as.
 * `Y.XmlElement.toString()` lowercases them when printing, so a shape copied
 * out of a probe's output would arrive as an element name the schema does not
 * know — and the failure is silent: the first client to connect deletes what
 * it cannot recognise and broadcasts that deletion as its own edit.
 *
 * The paragraph carries the three attributes the editor's paragraph declares
 * defaults for. Writing them here keeps the first client from filling them in
 * itself, which would be a write to the shared document performed by merely
 * opening it.
 * @returns The `blockGroup` element, ready to insert into a fragment.
 */
function buildInitialDocumentBlock(): Y.XmlElement {
  const group = new Y.XmlElement("blockGroup");
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", uuidv4());

  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("backgroundColor", "default");
  paragraph.setAttribute("textColor", "default");
  paragraph.setAttribute("textAlignment", "left");

  container.insert(0, [paragraph]);
  group.insert(0, [container]);
  return group;
}

/**
 * Encode the initial state for a fresh Space's content document.
 *
 * A document starts with one empty paragraph. Canvas and timeline start with
 * nothing — their editors build their own structure on first bind.
 *
 * The document seed exists because an empty fragment is not a safe starting
 * point under the editor's schema: two clients each binding to it fill the
 * gap locally and merge into two top-level groups, which the next client to
 * connect repairs by deleting one and broadcasting that deletion. Seeding one
 * block means what merges is only what users actually did.
 *
 * The `kind` parameter is what keeps this function the single home for the
 * initial-content policy: a future kind that needs a seed changes one switch
 * here, not a call site somewhere else.
 * @param kind - The kind of Space this content document belongs to.
 * @returns The encoded Yjs update, ready to persist as the initial state.
 */
export function encodeInitialSpaceContent(kind: SpaceType): Uint8Array {
  const doc = new Y.Doc();
  // Returning from inside each branch keeps the switch exhaustive: TypeScript
  // reports a missing return path when a fourth kind is added, which is the
  // point — a new kind must state its initial content on purpose.
  switch (kind) {
    case "document":
      documentBodyFragment(doc).insert(0, [buildInitialDocumentBlock()]);
      return Y.encodeStateAsUpdate(doc);
    case "canvas":
    case "timeline":
      return Y.encodeStateAsUpdate(doc);
  }
}
