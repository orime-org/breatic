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

/** Origin for the repair below — deliberately not one the manager tracks. */
const BODY_REPAIR_ORIGIN = 'document-body-repair';

/**
 * Put a block back when an undo or redo has left the body with none.
 *
 * ## Why this is not a rule inside the delete filter
 *
 * "The body holds at least one block" is a statement about the document AFTER
 * a step finishes. The delete filter runs DURING one, and sees a single yjs
 * item at a time — so a rule written there can only ever answer "may this one
 * item go", which is not the same question. Trying anyway produced two
 * measured failures:
 *
 * Keeping the last block when that block is a container (a list, a quote)
 * keeps the container and nothing else: yjs deletes children before parents,
 * and the children are not direct children of the body, so the rule never sees
 * them. The survivor is an empty `<bulletList>`, which the schema does not
 * allow — `listItem+` — and y-tiptap's own error recovery deletes it outright
 * on the next bind. The body reaches zero anyway, by a longer road.
 *
 * Keeping the last block when it carries attributes keeps the element and
 * drops them: an attribute is a map entry, so the filter asks upstream about
 * its container, and by then the container's text is gone and upstream reports
 * an empty, deletable container. An h3 comes back as an h1 — the exact harm
 * the wrapper above exists to prevent.
 *
 * Both are the same mistake: a whole-document constraint enforced one item at
 * a time. Chasing them would mean teaching the filter about subtrees, then
 * about attributes, then about whatever comes next.
 *
 * ## What this does instead
 *
 * `stack-item-popped` fires after the undo transaction has closed (yjs
 * `popStackItem` emits it outside the `transact`), so by then the step is
 * whole and the body can simply be read. If it is empty, one paragraph goes
 * back in.
 *
 * The write carries an origin the manager does not track, so it is not a new
 * user edit: it does not land on the undo stack and it does not clear the redo
 * the user is entitled to. That is what makes the repair invisible — the user
 * undoes, sees an empty document, and redo still brings their text back.
 * @param manager - The undo manager for this body.
 * @param body - The body it owns.
 */
function keepBodyInhabited(manager: Y.UndoManager, body: Y.XmlFragment): void {
  manager.on('stack-item-popped', () => {
    if (body.length > 0) return;
    body.doc?.transact(() => {
      body.push([new Y.XmlElement('paragraph')]);
    }, BODY_REPAIR_ORIGIN);
  });
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
 * Separately, the body is put back on its feet after each undo or redo if that
 * step left it with no blocks at all — see {@link keepBodyInhabited}.
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

  keepBodyInhabited(manager, body);

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
