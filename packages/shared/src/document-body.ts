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
 *   └─ …blocks        zero or more; an empty document is a legal state
 * ```
 *
 * There is no title block. The document's only name is the Space's name on
 * its tab, held in the project's meta document — one name, one home. A user
 * who wants a visual heading writes one.
 *
 * Emptiness is safe because the editor's schema allows it (`block*`): a
 * fragment with nothing in it maps to a document with no blocks, so no client
 * ever has to invent a filler block to satisfy the schema, and there is
 * nothing for a merge to duplicate. The hazard this replaces was measured
 * (2026-08-16): under a schema that demanded content, two clients opening the
 * same fresh document each papered over the gap locally, and one keystroke on
 * each side merged into two paragraphs nobody wrote together. With emptiness
 * legal, what merges is only what users actually did — and two people each
 * starting a paragraph in an empty document converging on two paragraphs is
 * the accepted, expected outcome.
 *
 * The selection ruling, the empty-state interaction and the select-all tiers
 * that sit on top of this shape are the editor's business — the decision
 * record lives in the private engineering repo (document structure DD,
 * 2026-08-17).
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
 * Every kind starts with nothing: canvas and timeline editors build their own
 * structure on first bind, and a document's empty state is legal by schema —
 * the editor offers a placeholder and opens a paragraph on the first click or
 * keystroke.
 *
 * The `kind` parameter is what keeps this function the single home for the
 * initial-content policy even though the three answers are currently the
 * same: a future kind that needs a seed changes one switch here, not a call
 * site somewhere else.
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
    case "canvas":
    case "timeline":
      return Y.encodeStateAsUpdate(doc);
  }
}
