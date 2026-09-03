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
import { defaultDeleteFilter, redoCommand, undoCommand, ySyncPluginKey, yUndoPlugin } from 'y-prosemirror';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';
import { withDestroyListenerCleanup } from '@web/data/yjs/undo-manager-cleanup';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

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

/**
 * Builds an undo manager for a document's body.
 *
 * Tracking only the sync plugin's origin is what keeps a peer's edits off our
 * stack, and it works by IDENTITY: yjs decides membership with `Set.has`, so
 * the key imported here has to be the very one the active sync plugin
 * dispatches with. Two copies of `y-prosemirror` in the bundle and the key
 * never matches — the stack captures nothing and undo silently does nothing.
 * @param doc - The document Space's Y.Doc.
 * @returns A manager bound to that document's body.
 */
export function createDocumentUndoManager(doc: Y.Doc): Y.UndoManager {
  // Wrapped so `destroy()` also detaches the doc listener yjs leaks — see
  // `withDestroyListenerCleanup`; the canvas manager has the same problem and
  // the same wrapper.
  return withDestroyListenerCleanup(
    doc,
    () =>
      new Y.UndoManager(documentBodyFragment(doc), {
        trackedOrigins: new Set([ySyncPluginKey]),
        deleteFilter: isDeletableByUndo,
        captureTransaction: (tr) => tr.meta.get('addToHistory') !== false,
      }),
  );
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
    prosemirrorPlugins: [yUndoPlugin({ undoManager: manager })],
    dependsOn: ['yCursor', 'ySync'],
    undoCommand,
    redoCommand,
  }) as never)();
}
