// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Brings collaborator carets back after a local structural edit.
 *
 * `@tiptap/y-tiptap` 3.0.7 made its cursor plugin drop every remote decoration
 * on a local structural transaction — pressing Enter, pasting several
 * paragraphs, deleting across a paragraph boundary. The reasoning is sound: the
 * ProseMirror document leads the Yjs mapping through such an edit, so a cursor
 * parked at its old position would be painted somewhere wrong. Its own comment
 * says it waits for "the collaborator to publish its new cursor".
 *
 * That wait is where it breaks down. The collaborator has no idea our document
 * just changed shape, and an idle client's awareness heartbeats are deep-equal,
 * so they surface as `update` and never as the `change` the cursor plugin
 * listens for. Measured: after a local Enter the remote caret is gone and stays
 * gone — still absent 200ms later — and only reappears when that person happens
 * to move. In a prompt people type into together, one Enter blanking everyone
 * else's caret for as long as they sit still is not something to ship.
 *
 * So we ask for the redraw ourselves. Everything used here is upstream's own:
 * `isStructuralTransaction` is the very predicate its plugin branches on, so the
 * two cannot disagree about what counts as structural, and `setMeta` is the
 * channel its own awareness listener uses to request a rebuild — batching
 * included, which is what lands the request on the next tick, once the mapping
 * is back in step. The decorations are then rebuilt from the CURRENT awareness
 * state, which is also why the caret returns correctly dimmed rather than in
 * whatever state it held before.
 *
 * Remote applies are left alone: they rebuild the decorations on their own way
 * through, and asking again would only redo work already done.
 */

import { Extension } from '@tiptap/core';
import {
  isStructuralTransaction,
  setMeta,
  ySyncPluginKey,
  yCursorPluginKey,
} from '@tiptap/y-tiptap';

export const CollabCaretRefresh = Extension.create({
  name: 'collabCaretRefresh',

  /**
   * Requests a cursor rebuild when a local structural edit has just cleared it.
   * @param props - The transaction payload TipTap hands every extension.
   * @param props.editor - The editor the transaction landed on.
   * @param props.transaction - The transaction that landed.
   * @throws {never}
   */
  onTransaction({ editor, transaction }): void {
    if (!transaction.docChanged) return;
    // Without collaboration wired there is no cursor plugin to talk to.
    if (yCursorPluginKey.getState(editor.state) === undefined) return;
    const sync = ySyncPluginKey.getState(editor.state) as
      | { isChangeOrigin?: boolean }
      | undefined;
    if (sync?.isChangeOrigin === true) return;
    if (!isStructuralTransaction(transaction, transaction.before)) return;
    setMeta(editor.view, yCursorPluginKey, { awarenessUpdated: true });
  },
});
