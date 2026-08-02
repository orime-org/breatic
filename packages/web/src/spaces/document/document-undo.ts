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
import { documentBodyFragment } from '@web/spaces/document/document-yjs';

/**
 * What undo is allowed to delete.
 *
 * Upstream's filter refuses a container that still holds content, which is what
 * keeps a co-editor's text out of my undo. It does not refuse that container's
 * ATTRIBUTES: an attribute is a map entry rather than a child, so it fails
 * `defaultDeleteFilter`'s first test — `item.content instanceof ContentType` —
 * and is always deletable. Before the protected set covered every block type
 * this could not be observed, because the container went too.
 *
 * Measured with the real binding: Alice writes `<h3>Plan</h3>`, Bob appends
 * into it, Alice undoes. With upstream's filter alone the heading survives as
 * `<heading> BOB</heading>` and renders as an h1 — Alice's `level` went with
 * her text, for everyone, and Bob cannot undo it because it is not on his
 * stack. A code block loses its language and stops highlighting; an ordered
 * list loses its start and renumbers from 1.
 *
 * The condition is deliberately the same one upstream uses for the container:
 * protected type, still populated. When nobody else has written into the block
 * the container is deletable, its attributes go with it, and undo is unchanged.
 * And when the local edit WAS an attribute change, undo still restores the old
 * value — yjs replays that as a write, not as a deletion of Alice's item, so
 * this filter never sees it. Both directions are pinned in
 * `undo-protects-collaborator-text`.
 * @param item - The yjs item undo proposes to delete.
 * @returns True to allow the deletion, false to keep the item.
 */
function isDeletableByUndo(item: Y.Item): boolean {
  const nodes = protectedNodes();
  if (!defaultDeleteFilter(item, nodes)) return false;
  const parent: unknown = item.parent;
  return !(
    item.parentSub !== null &&
    parent instanceof Y.XmlElement &&
    nodes.has(parent.nodeName) &&
    parent.length > 0
  );
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
 * An undo manager that reports every undo and redo, including the ones that
 * change nothing.
 *
 * yjs discards stack entries whose content a collaborator has since deleted,
 * and since undoing such an entry alters nothing it announces nothing either —
 * no event fires, and anything mirroring availability from events goes stale.
 * The manager therefore reports the ACTION rather than its effect, so a reader
 * always gets a chance to re-check.
 *
 * Every path — the toolbar, the keyboard shortcuts, a direct command — ends up
 * calling `undo()` / `redo()` on this object, so reporting here covers all of
 * them. The alternative was a "remember to re-read afterwards" contract on each
 * caller, which the keyboard path had already quietly broken.
 */
export interface DocumentUndoManager extends Y.UndoManager {
  /**
   * Subscribe to undo / redo having run.
   * @param listener - Called after each undo or redo, effect or not.
   * @returns Unsubscribe.
   */
  onAfterHistoryAction: (listener: () => void) => () => void;
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
 * An earlier version of this file added a rule refusing to delete the body's
 * last child, to stop undo emptying the fragment; `seedEmptyBody` in
 * `document-yjs` removes the need by keeping a paragraph there from the start.
 *
 * `captureTransaction` honours the `addToHistory: false` marker, so
 * machine-driven edits stay off the stack.
 * @param doc - The document Space's Y.Doc.
 * @returns A manager bound to that document's body.
 */
export function createDocumentUndoManager(doc: Y.Doc): DocumentUndoManager {
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
      }) as DocumentUndoManager,
  );

  const listeners = new Set<() => void>();
  const undo = manager.undo.bind(manager);
  const redo = manager.redo.bind(manager);
  /** Tells subscribers an action ran, whatever it did or did not change. */
  const announce = (): void => {
    listeners.forEach((listener) => listener());
  };
  manager.undo = (): ReturnType<Y.UndoManager['undo']> => {
    const item = undo();
    announce();
    return item;
  };
  manager.redo = (): ReturnType<Y.UndoManager['redo']> => {
    const item = redo();
    announce();
    return item;
  };
  manager.onAfterHistoryAction = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return (): void => {
      listeners.delete(listener);
    };
  };

  return manager;
}
