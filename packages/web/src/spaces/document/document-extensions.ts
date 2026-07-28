// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document editor's extension list — and with it, its ProseMirror schema.
 *
 * **The schema ships whole, ahead of the UI that fills it.** Everything the
 * planned slices will put in a document is registered here even where nothing
 * can yet create it. This is not tidiness, it is a data-safety requirement:
 * y-tiptap deletes any node, mark, or ATTRIBUTE its schema does not recognise,
 * and commits that deletion as an ordinary local change — so it syncs to every
 * peer and persists. A client on an older bundle would therefore erase content
 * newer clients had written, silently and with no entry in anyone's undo stack.
 *
 * Consequence for later slices: **adding UI is fine, adding schema is not.** A
 * new node, mark, or attribute has to be introduced here and released before
 * anything can produce it. Attributes are the easy one to miss — extensions
 * like TextAlign contribute no node at all, only a field on existing ones, and
 * an undeclared field is dropped exactly like an undeclared node.
 *
 * Where this is NOT yet complete: the comment slice's anchoring primitive is
 * still open in the design (a mark was the original plan and was sent back for
 * a decision), so whatever it settles on has to be registered here and released
 * before comments ship.
 */

import type { Extensions } from '@tiptap/core';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import { Highlight } from '@tiptap/extension-highlight';
import { Image } from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableRow } from '@tiptap/extension-table-row';
import { TaskItem } from '@tiptap/extension-task-item';
import { TaskList } from '@tiptap/extension-task-list';
import { TextAlign } from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import StarterKit from '@tiptap/starter-kit';
import type * as Y from 'yjs';

import {
  renderCollabCaret,
  renderCollabSelection,
} from '@web/spaces/canvas/generate/caret-render';
import { CollabUndoSelection } from '@web/spaces/canvas/generate/collab-undo-selection';
import { scopeUndoManagerToEditor } from '@web/spaces/document/document-undo';
import { Audio, Video } from '@web/spaces/document/document-media-nodes';

/** A collaborator's caret identity, as published through awareness. */
export interface DocumentCaretUser {
  name: string;
  color: string;
  hue: string;
}

/** Inputs that switch on the collaborative layers; all optional. */
export interface DocumentExtensionOptions {
  /**
   * The document's body fragment. Supplying it binds the editor to Yjs; the
   * schema is identical either way, so a schema-only caller can omit it.
   */
  fragment?: Y.XmlFragment;
  /**
   * Provider whose awareness carries collaborator carets. The caret extension
   * throws on a null provider, so it mounts only once this is present.
   */
  caretProvider?: { awareness: unknown } | null;
  /** This user's caret identity, published to other clients. */
  caretUser?: DocumentCaretUser | null;
  /** Empty-state text. */
  placeholder?: string;
  /**
   * The undo manager to use. Supplying one keeps the history alive across an
   * editor rebuild — a Space tab switch remounts the body, and the extension's
   * own manager would die with it. See `getDocumentUndoManager` in `document-undo.ts`.
   */
  undoManager?: Y.UndoManager;
}

/**
 * Build the document editor's extension list.
 *
 * The schema-bearing extensions are unconditional — see the module doc for why
 * they must not vary by slice or by whether collaboration is active. Only the
 * collaborative layers (binding, carets) and the placeholder are conditional,
 * and none of them contributes a node or mark.
 * @param options - Collaborative bindings and cosmetics; omit for schema-only use.
 * @returns The full extension list, ready for `useEditor`.
 */
export function buildDocumentExtensions(
  options: DocumentExtensionOptions = {},
): Extensions {
  const { fragment, caretProvider, caretUser, placeholder, undoManager } =
    options;

  const extensions: Extensions = [
    StarterKit.configure({
      // Collaboration owns history through the shared Yjs undo manager, which
      // tracks only this client's transactions. Leaving StarterKit's own
      // history in place gives the editor a second, client-blind undo stack:
      // a peer's edit arrives as a local transaction there, so one Cmd+Z
      // deletes their paragraph. Verified by mutation — switching this back on
      // turns the document to an empty string in the per-client undo test.
      undoRedo: false,
    }),
    // ── Schema completed here; UI for these lands in later slices ──
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    Image,
    Video,
    Audio,
    Highlight.configure({ multicolor: true }),
    TextStyle,
    // Attributes count too, not just node and mark names. TextAlign adds no
    // node of its own — it hangs a `textAlign` attribute on existing ones — and
    // y-tiptap strips any attribute the local schema does not declare, by the
    // same mechanism that drops an unknown node. Ship it now, with the toolbar
    // control following later, or the release that adds alignment would have
    // older clients erasing it from every paragraph they touch.
    //
    // The media nodes are on the list because the media slice specifies an
    // alignment control for images, and because all three are block-level: the
    // capability is the same shape for each, so declaring it once here costs a
    // single array entry, while omitting it costs a migration. Which of them
    // gets a toolbar button is a separate, reversible decision — an attribute
    // nothing writes is inert, an attribute nothing declared is a data loss.
    TextAlign.configure({
      types: ['heading', 'paragraph', 'image', 'video', 'audio'],
    }),
  ];

  if (fragment) {
    extensions.push(
      Collaboration.configure({
        fragment,
        // Handing over our own manager keeps the undo stack alive across an
        // editor rebuild; without it the extension builds a fresh one and a
        // tab switch silently empties the history. It goes in wrapped, because
        // the binding releases its subscriptions by destroying the manager
        // outright — see {@link scopeUndoManagerToEditor} for why that has to
        // be narrowed to this editor's own.
        ...(undoManager
          ? { yUndoOptions: { undoManager: scopeUndoManagerToEditor(undoManager) } }
          : {}),
      }),
      // Undo must restore the selection the edit started from. Upstream emits
      // its stack-item-popped hand-off AFTER the restore transaction has run,
      // so the editor keeps the caret where it was at undo time and the late
      // write lingers — the next remote change then applies that stale
      // selection and yanks the local caret. This extension hands the stored
      // selection over in time. Same fix the canvas prompt editor carries.
      CollabUndoSelection,
    );
  }

  // Carets need both an awareness-bearing provider and an identity to publish;
  // the extension throws when the provider is absent.
  if (caretProvider?.awareness && caretUser) {
    extensions.push(
      CollaborationCaret.configure({
        provider: caretProvider,
        user: caretUser,
        // Receiver-side safe render: a whitelisted hue resolves to a theme
        // token, so a remote client's colour string is never inlined into the
        // DOM. Both builders are supplied — the default selectionRender
        // inlines the raw remote colour too.
        render: renderCollabCaret,
        selectionRender: renderCollabSelection,
      }),
    );
  }

  if (placeholder !== undefined) {
    extensions.push(Placeholder.configure({ placeholder }));
  }

  return extensions;
}
