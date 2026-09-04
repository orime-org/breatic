// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The document body's undo manager, and the plugin that uses it.
 *
 * Tracking origins decides WHICH edits land on this client's stack. It says
 * nothing about what is destroyed when one of them is rolled back — and two
 * people writing into the same block share a container, so undoing our own
 * insert of that container takes their text with it, synced to everyone and
 * absent from their undo stack.
 *
 * yjs guards that with a delete filter, and two things about it are ours:
 *
 * - **The set of protected names.** y-prosemirror defaults to one, `paragraph`
 *   (`undo-plugin.js:45`), because that default was written for documents made
 *   of paragraphs. Ours holds nine block types inside two container types.
 * - **The filter is wrapped**, because saving the container is not enough:
 *   upstream's never sees the container's ATTRIBUTES, so a heading came back
 *   without its level and rendered as an h1. Three of the four props a block
 *   carries here are new to this migration — `quoted`, `numbered`, `number` —
 *   and all three are attributes.
 *
 * The extension takes the key BlockNote's own undo extension uses. Extensions
 * are de-duplicated by key and the first registration wins
 * (`ExtensionManager/index.ts:178-181`), and a caller's extensions are
 * registered ahead of `CollaborationExtension`, so registering this one
 * replaces the built-in. Keeping the key is also what leaves `editor.undo()`
 * working: it looks the extension up by that exact string
 * (`StateManager.ts:216-231`).
 */

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { defaultDeleteFilter, redoCommand, undoCommand, ySyncPluginKey, yUndoPlugin } from 'y-prosemirror';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';
import { withDestroyListenerCleanup } from '@web/data/yjs/undo-manager-cleanup';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentUndoSelectionPlugin } from '@web/spaces/document/document-undo-selection';

/** Computed once; the schema is fixed for the lifetime of the bundle. */
let protectedNodesCache: Set<string> | null = null;

/**
 * Every block-level node the document can hold.
 *
 * Derived from the schema rather than listed, so a slice that registers a new
 * block type is protected the day it lands and there is no second list to
 * drift out of step with the first.
 * @returns Block node names, excluding the document root itself.
 */
function protectedNodes(): Set<string> {
  if (protectedNodesCache) {
    return protectedNodesCache;
  }
  const probe = new Y.Doc();
  try {
    const { pmSchema } = buildDocumentEditor({
      fragment: probe.getXmlFragment('probe'),
    });
    protectedNodesCache = new Set(
      Object.values(pmSchema.nodes)
        .filter((node) => node.isBlock && node.name !== 'doc')
        .map((node) => node.name),
    );
    return protectedNodesCache;
  } finally {
    probe.destroy();
  }
}

/**
 * What undo is allowed to delete.
 *
 * Upstream's filter refuses a container that still holds content, which is what
 * keeps a co-editor's text out of our undo. It does not extend that to the
 * container's attributes: an attribute is a map entry, so it fails the test for
 * a `ContentType` and stays deletable.
 *
 * So an attribute is kept exactly when its container is — the same question is
 * put to upstream about the parent rather than restated here, which leaves one
 * rule in one place. A container with no `_item` is a root type, which undo
 * never deletes.
 * @param item - The yjs item undo proposes to delete.
 * @returns True to allow the deletion, false to keep the item.
 */
function isDeletableByUndo(item: Y.Item): boolean {
  const nodes = protectedNodes();
  if (!defaultDeleteFilter(item, nodes)) {
    return false;
  }
  if (item.parentSub === null) {
    return true;
  }
  const container = (item.parent as { _item?: Y.Item | null } | null)?._item;
  return container == null || defaultDeleteFilter(container, nodes);
}

/** Whether the dispatch now reaching Yjs is one the user made. */
interface UserDrivenMarker {
  /** False while a `addToHistory: false` dispatch is being written through. */
  userDriven: boolean;
}

/** Each manager's marker, written by the plugin and read by the manager. */
const markers = new WeakMap<Y.UndoManager, UserDrivenMarker>();

/**
 * Builds an undo manager for a document's body.
 *
 * Tracking only the sync plugin's origin is what keeps a peer's edits off our
 * stack, and it works by IDENTITY: yjs decides membership with `Set.has`, so
 * the key imported here has to be the very one the active sync plugin
 * dispatches with. Two copies of `y-prosemirror` in the bundle and the key
 * never matches — the stack captures nothing and undo silently does nothing.
 *
 * What keeps a MACHINE's edit off the stack is the marker rather than the
 * `addToHistory` meta yjs receives. y-prosemirror carries that meta across
 * (`sync-plugin.js:147` records it, `:228` writes it onto the Yjs transaction),
 * but `:147` OVERWRITES it on every ProseMirror transaction, and one dispatch
 * here is more than one transaction: a new block needs an id, and BlockNote's
 * `uniqueID` plugin stamps one from an `appendTransaction` that carries no meta
 * of its own. Measured: one dispatch marked `addToHistory: false` reaches Yjs
 * as `addToHistory: true`, and the machine's edit lands on the user's stack.
 *
 * {@link documentUndoSelectionPlugin} answers the same upstream behaviour with
 * the same test — the first doc-changing, non-appended transaction of a
 * dispatch is the one that speaks for it.
 * @param doc - The document Space's Y.Doc.
 * @returns A manager bound to that document's body.
 */
export function createDocumentUndoManager(doc: Y.Doc): Y.UndoManager {
  const marker: UserDrivenMarker = { userDriven: true };
  // Wrapped so `destroy()` also detaches the doc listener yjs leaks — see
  // `withDestroyListenerCleanup`; the canvas manager has the same problem and
  // the same wrapper.
  const manager = withDestroyListenerCleanup(
    doc,
    () =>
      new Y.UndoManager(documentBodyFragment(doc), {
        trackedOrigins: new Set([ySyncPluginKey]),
        deleteFilter: isDeletableByUndo,
        captureTransaction: () => marker.userDriven,
      }),
  );
  markers.set(manager, marker);
  return manager;
}

/**
 * The plugin that records who a dispatch belongs to.
 *
 * Two kinds of transaction are passed over, and both would answer wrongly.
 *
 * The follow-ups BlockNote appends to a dispatch carry no `addToHistory` of
 * their own, so letting one of those answer turns a machine's edit back into
 * the user's — the same behaviour `documentUndoSelectionPlugin` steps around.
 *
 * A transaction the sync binding built to bring Yjs's content into this view
 * is marked `addToHistory: false` by upstream (`sync-plugin.js:355`), and undo
 * puts content back through exactly that path. Letting it answer leaves the
 * marker false for whatever comes next, and the redo that follows an undo is
 * refused. Upstream asks the same two questions together at `:214`.
 * @param marker - The marker the manager reads.
 * @returns The ProseMirror plugin.
 */
function userDrivenPlugin(marker: UserDrivenMarker): Plugin {
  return new Plugin({
    key: new PluginKey('documentUndoUserDriven'),
    state: {
      /**
       * Contributes no state of its own.
       * @returns Null.
       */
      init: (): null => null,

      /**
       * Records the dispatch's own answer, passing over the two kinds above.
       * @param tr - The transaction being applied.
       * @returns Null.
       */
      apply: (tr): null => {
        const sync = tr.getMeta(ySyncPluginKey) as
          | { isChangeOrigin?: boolean }
          | undefined;
        if (
          tr.docChanged &&
          tr.getMeta('appendedTransaction') === undefined &&
          sync?.isChangeOrigin !== true
        ) {
          marker.userDriven = tr.getMeta('addToHistory') !== false;
        }
        return null;
      },
    },
  });
}

/**
 * The extension that registers the undo plugin over a manager we hold.
 * @param manager - The manager built by {@link createDocumentUndoManager}.
 * @returns The extension, for the assembly to register.
 */
export function documentUndoExtension(
  manager: Y.UndoManager,
): ExtensionFactoryInstance {
  return createExtension(() => ({
    key: 'yUndo',
    // The selection plugin sits SECOND on purpose. Both it and `yUndoPlugin`
    // subscribe `stack-item-added`, and the one that writes last is the one
    // whose selection ends up on the stack item; plugin views run in array
    // order, so this is what settles that without depending on the extension
    // sort.
    prosemirrorPlugins: [
      yUndoPlugin({ undoManager: manager }),
      documentUndoSelectionPlugin(),
      userDrivenPlugin(
        markers.get(manager) ?? { userDriven: true },
      ),
    ],
    dependsOn: ['yCursor', 'ySync'],
    undoCommand,
    redoCommand,
  }) as never)();
}
