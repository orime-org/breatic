// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document editor's extension list — and with it, its ProseMirror schema.
 *
 * **The schema is complete from the first release.** Every node and mark the
 * document will ever hold is registered here, even where the UI that creates
 * it arrives in a later slice. This is not tidiness, it is a data-safety
 * requirement: y-tiptap deletes any node or mark its schema does not
 * recognise and commits that deletion as an ordinary local change, which then
 * syncs to every peer and persists. A client running an older bundle would
 * therefore erase content newer clients had written — silently, permanently,
 * and with no entry in anyone's undo stack. Registering everything up front
 * removes the failure mode rather than mitigating it.
 *
 * Consequence for later slices: **adding UI is fine, adding schema is not.**
 * A new node or mark type must be introduced here and shipped before any UI
 * can produce it.
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
import { TextStyle } from '@tiptap/extension-text-style';
import StarterKit from '@tiptap/starter-kit';
import type * as Y from 'yjs';

import {
  renderCollabCaret,
  renderCollabSelection,
} from '@web/spaces/canvas/generate/caret-render';
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
  const { fragment, caretProvider, caretUser, placeholder } = options;

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
  ];

  if (fragment) {
    extensions.push(Collaboration.configure({ fragment }));
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
