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

import { t } from '@breatic/shared';

import type { CaretUserIdentity } from '@web/features/collab-editor/use-caret-user';
import { buildCollabExtensions } from '@web/features/collab-editor/collab-extensions';
import { Audio, Video } from '@web/spaces/document/document-media-nodes';
import { LocaleRedraw } from '@web/spaces/document/locale-redraw';

/** Inputs that switch on the collaborative layers; all optional. */
export interface DocumentExtensionOptions {
  /**
   * The document's body fragment — what binds this editor to Yjs.
   *
   * Required. It was optional so that a schema-only caller could omit it, but
   * the only such callers were tests: production always has a fragment. A
   * shape that exists for tests is a shape nobody maintains, and this one hid a
   * silent "collaboration not wired up" branch. Tests wanting the schema pass a
   * throwaway fragment — the collaboration extensions contribute no node or
   * mark, so the schema is identical either way.
   */
  fragment: Y.XmlFragment;
  /**
   * Provider whose awareness carries collaborator carets. The caret extension
   * throws on a null provider, so it mounts only once this is present.
   */
  caretProvider?: { awareness: unknown } | null;
  /** This user's caret identity, published to other clients. */
  caretUser?: CaretUserIdentity | null;
  /**
   * The editor's undo manager. Held by the caller rather than left to the
   * binding so it can be read without a plugin-key lookup; its lifetime is the
   * editor's, which is what the binding assumes.
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
 * @param options - The body fragment plus the collaborative wiring.
 * @returns The full extension list, ready for `useEditor`.
 */
export function buildDocumentExtensions(
  options: DocumentExtensionOptions,
): Extensions {
  const { fragment, caretProvider, caretUser, undoManager } = options;

  const extensions: Extensions = [
    StarterKit.configure({
      // Collaboration owns history through the shared Yjs undo manager, which
      // tracks only this client's transactions. Leaving StarterKit's own
      // history in place gives the editor a second, client-blind undo stack:
      // a peer's edit arrives as a local transaction there, so one Cmd+Z
      // deletes their paragraph. Verified by mutation — switching this back on
      // turns the document to an empty string in the per-client undo test.
      undoRedo: false,
      // Off for the same reason, one layer down: TrailingNode appends a
      // paragraph whenever the last block is not one, and in a shared document
      // that append is a WRITE. It broadcasts, it lands on the undo stack of
      // whoever opened the file, and it fires for a read-only viewer too —
      // `setEditable(false)` stops keystrokes, not a plugin's own
      // appendTransaction. The server drops a viewer's update without an error,
      // so that client sits permanently one paragraph ahead with nothing to
      // signal it.
      //
      // It also revives the defect the seeded body exists to prevent: undo back
      // past the appended paragraph, click once, and it is re-appended as a
      // fresh local edit — clearing the redo stack and stranding the text just
      // undone. The seed only ever covered an EMPTY body; this fires on a body
      // that merely ENDS in a heading, a table, an image.
      //
      // What is lost is the convenience of always having a paragraph to click
      // after a trailing table or image. That belongs to the editing slice and
      // has to be built without writing to the document — a rendered affordance
      // that inserts only when the user actually puts the caret in it.
      trailingNode: false,
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

  // The collaboration wiring is shared with every other collaborative editor —
  // history binding, undo selection hand-off, caret refresh, caret rendering.
  // Assembling it here by hand is how this editor shipped without the caret
  // refresh in the first place. Supplying the undo manager is about being able
  // to READ it: a plugin-key lookup misses silently against a duplicated
  // binding. It is not about outliving anything — the manager and the editor
  // share a lifetime, exactly as the binding assumes, because the EDITOR is
  // what survives a tab switch (see `document-editor-cache`).
  extensions.push(
    ...buildCollabExtensions({
      fragment,
      caretProvider,
      caretUser,
      undoManager,
    }),
  );

  // Resolved per render of the placeholder decoration rather than captured as
  // a string, because the editor is built once per document and would
  // otherwise keep whichever language was active at that moment. `t` is the
  // shared engine — `useTranslation` returns this same function and exists
  // only to re-render subscribers — so calling it here reads the live locale.
  extensions.push(
    Placeholder.configure({
      placeholder: () => t('spaces.document.placeholder'),
    }),
    // Resolving the string per render (above) reads the live locale, but a
    // decoration is only redrawn when something dispatches — and switching
    // language dispatches nothing. This asks for the redraw.
    LocaleRedraw,
  );

  return extensions;
}
