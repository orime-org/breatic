// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document body's undo manager.
 *
 * It is built here and handed to the Collaboration extension rather than left
 * to the extension, for one reason: holding the manager beats looking it up.
 * The alternative is finding the undo plugin by its key NAME and reading the
 * manager out of its state, which misses silently if a second copy of the
 * binding ever enters the bundle — the key is then minted as `y-undo$1` and the
 * lookup simply returns nothing. A reference we created cannot go missing.
 *
 * Its lifetime is the editor's, which is what upstream assumes. That holds here
 * because the EDITOR outlives tab switches (see `document-editor-cache`), so
 * nothing has to be done to keep this manager alive across one — the earlier
 * shape of this file, which cached the manager and fought the binding's
 * teardown to keep it, is gone along with the problem it existed for.
 */

import { getSchema } from '@tiptap/core';
import { defaultDeleteFilter, ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import { withDestroyListenerCleanup } from '@web/data/yjs/undo-manager-cleanup';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { documentBodyFragment } from '@breatic/shared';

/**
 * What undo is allowed to delete.
 *
 * Upstream's filter refuses a container that still holds content, which is what
 * keeps a co-editor's text out of my undo. It does not extend that to the
 * container's ATTRIBUTES: an attribute is a map entry, so it fails the filter's
 * test for a `ContentType` and stays deletable. While the protected set held
 * only `paragraph` this could not be observed, because the container went too.
 *
 * Measured with the real binding: Alice writes `<h3>Plan</h3>`, Bob appends
 * into it, Alice undoes. With upstream's filter alone the heading survives as
 * `<heading> BOB</heading>` and renders as an h1 — Alice's `level` left with
 * her text, for everyone, and Bob cannot undo it because it is not on his
 * stack. A code block comes back without its language, an ordered list without
 * its start.
 *
 * So an attribute is kept exactly when its container is: the same question is
 * put to upstream about the parent, rather than restated here. Restating it was
 * the first attempt, and it produced two conditions no test could reach —
 * "protected type" and "still populated" could both be broken with the suite
 * green, because the only case behind them was one upstream already decides.
 * Delegating leaves one rule in one place.
 *
 * A container with no `_item` is a root type, which undo never deletes.
 *
 * Undoing an attribute CHANGE is unaffected: the old value comes back. That is
 * pinned by test rather than explained here — the mechanism is inside yjs's
 * redo path and I have not traced it far enough to describe it.
 * @param item - The yjs item undo proposes to delete.
 * @returns True to allow the deletion, false to keep the item.
 */
function isDeletableByUndo(item: Y.Item): boolean {
  const nodes = protectedNodes();
  if (!defaultDeleteFilter(item, nodes)) return false;
  if (item.parentSub === null) return true;
  const container = (item.parent as { _item?: Y.Item | null } | null)?._item;
  return container == null || defaultDeleteFilter(container, nodes);
}

/** Computed once; the schema is fixed for the lifetime of the bundle. */
let protectedNodesCache: Set<string> | null = null;

/**
 * Every block-level node the document can hold.
 *
 * Derived from the schema rather than listed, so a slice that registers a new
 * block type is protected the day it lands — nobody has to remember to add it
 * here, and there is no second list to drift out of step with the first.
 * @returns Block node names, excluding the document root itself.
 */
function protectedNodes(): Set<string> {
  if (protectedNodesCache) return protectedNodesCache;
  const probe = new Y.Doc();
  try {
    const schema = getSchema(
      buildDocumentExtensions({ fragment: probe.getXmlFragment('probe') }),
    );
    protectedNodesCache = new Set(
      Object.values(schema.nodes)
        .filter((node) => node.isBlock && node.name !== 'doc')
        .map((node) => node.name),
    );
    return protectedNodesCache;
  } finally {
    probe.destroy();
  }
}

/**
 * Build an undo manager for a document's body.
 *
 * Tracking only the sync plugin's origin is what keeps a peer's edits off our
 * stack. It works by IDENTITY: Yjs decides membership with `Set.has`, so the
 * key object imported here has to be the very one the active sync plugin
 * dispatches with. `@tiptap/y-tiptap` is a direct dependency of `web`, pinned
 * through the catalog, so the risk is not importing a stray transitive copy —
 * it is the collaboration extensions resolving their own. Two copies in the
 * bundle and the key never matches: the stack captures nothing and undo
 * silently does nothing at all.
 * Single-copy is therefore an invariant, enforced by a test of its own
 * (`features/collab-editor/__tests__/single-y-tiptap-copy`), not something to
 * re-litigate here; the name-based lookups in `collab-plugin-keys` are no help
 * against it, and say so.
 *
 * Tracking the origin decides WHICH edits land on our stack. It says nothing
 * about what gets destroyed when one of them is rolled back — and two people
 * writing into the same block share a container, so undoing our own insert of
 * that container takes their text with it, synced to everyone and absent from
 * their undo stack. yjs guards this with a delete filter, which has to be
 * supplied here: providing our own manager means the binding never builds one
 * and its defaults never apply.
 *
 * Two things about that filter are ours. **The set of protected names**, which
 * upstream defaults to one — `paragraph` — because it was written for an editor
 * whose documents are only paragraphs. Measured, with the set as the only
 * difference: Alice writes "Plan" in a block, Bob appends " v2-from-bob",
 * Alice presses undo.
 *
 *   paragraph   upstream default → `<paragraph> v2-from-bob</paragraph>`
 *   heading     upstream default → ``  (everything gone)
 *   blockquote  upstream default → ``  (everything gone)
 *   codeBlock   upstream default → ``  (everything gone)
 *
 * So the set comes from {@link protectedNodes} — every block type in the
 * schema, derived rather than listed.
 *
 * **And the filter is wrapped**, because saving the container is not enough on
 * its own: upstream's never sees the container's attributes, so the heading
 * came back as an h1. {@link isDeletableByUndo} covers those too. Alice's own
 * text still comes out in every case.
 *
 * Nothing here guards against the body running out of blocks. Running out is
 * a legal resting state — `content: 'block*'` allows zero — and undo crosses
 * it correctly in both directions: a confirmed whole-document delete undoes
 * back to the content and redoes back to empty, and the first block written
 * into an empty document undoes back to zero blocks. Measured, and pinned in
 * `__tests__/collab-zero-block.test.ts`.
 *
 * `captureTransaction` honours the `addToHistory: false` marker, so
 * machine-driven edits stay off the stack.
 * @param doc - The document Space's Y.Doc.
 * @returns A manager bound to that document's body.
 */
export function createDocumentUndoManager(doc: Y.Doc): Y.UndoManager {
  const body = documentBodyFragment(doc);
  // Wrapped so `destroy()` also detaches the doc listener yjs leaks — see
  // `withDestroyListenerCleanup`; the canvas manager has the same problem and
  // the same wrapper.
  const manager = withDestroyListenerCleanup(
    doc,
    () =>
      new Y.UndoManager(body, {
        trackedOrigins: new Set([ySyncPluginKey]),
        deleteFilter: isDeletableByUndo,
        captureTransaction: (tr) => tr.meta.get('addToHistory') !== false,
      }),
  );

  return manager;
}
