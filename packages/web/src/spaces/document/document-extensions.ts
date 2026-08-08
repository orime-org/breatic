// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document editor's extension list.
 *
 * **This slice connects the document to a shared Yjs document. It does not
 * change what a user can write into it.** StarterKit is left as it was — every
 * heading, list, quote, code block and mark it ships stays exactly as it
 * behaved before, because the editing feature set is a separate body of work
 * with its own slice.
 *
 * Two of StarterKit's defaults ARE switched off, and both for the same reason:
 * they are safe in a private editor and unsafe in a shared one. Each is
 * explained where it is switched off. If a third ever joins them, it needs the
 * same justification — "connecting this document to a shared one broke it" —
 * and nothing else qualifies.
 */

import type { Extensions } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Placeholder } from '@tiptap/extension-placeholder';
import StarterKit from '@tiptap/starter-kit';
import type * as Y from 'yjs';

import { DOCUMENT_TITLE_NODE, t } from '@breatic/shared';

import { buildCollabExtensions } from '@web/features/collab-editor/collab-extensions';
import type { ResolveCollaboratorName } from '@web/features/collab-editor/caret-render';
import { DocumentTitle } from '@web/spaces/document/document-title';
import { LocaleRedraw } from '@web/spaces/document/locale-redraw';

/** The body fragment, plus the optional collaborative layers. */
export interface DocumentExtensionOptions {
  /**
   * The document's body fragment — what binds this editor to Yjs.
   *
   * Required. It was optional so that a schema-only caller could omit it, and
   * that shape hid a silent "collaboration not wired up" branch: forget the
   * fragment and you get a working editor bound to nothing. Callers that want
   * only the schema pass a throwaway fragment instead — the collaboration
   * extensions contribute no node or mark, so the schema is identical either
   * way. `protectedNodes` in `document-undo` does exactly that in production,
   * to read the schema's block types.
   */
  fragment: Y.XmlFragment;
  /**
   * Provider whose awareness carries collaborator carets. The caret extension
   * throws on a null provider, so it mounts only once this is present.
   */
  caretProvider?: { awareness: unknown } | null;
  /** Resolves collaborators' display names from the project roster (#1882). */
  resolveCollaboratorName?: ResolveCollaboratorName;
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
 * Only the collaborative layers (binding, carets) and the placeholder are
 * conditional, and none of them contributes a node or mark — so the schema is
 * the same whether or not collaboration is active.
 * @param options - The body fragment plus the collaborative wiring.
 * @returns The full extension list, ready for `useEditor`.
 */
export function buildDocumentExtensions(
  options: DocumentExtensionOptions,
): Extensions {
  const { fragment, caretProvider, undoManager, resolveCollaboratorName } =
    options;

  const extensions: Extensions = [
    // `title block*` — one title, always first, then any number of body
    // blocks INCLUDING none. Both halves are load-bearing and neither works
    // alone: the title is what keeps the shared fragment inhabited, and once
    // it does, requiring a body block would re-open the very gap the title
    // closes (two people deleting different body blocks merge into a body
    // with none, and the editor's repair for that counts as a user edit).
    // `@breatic/shared`'s `document-body` carries the full reasoning.
    Document.extend({ content: `${DOCUMENT_TITLE_NODE} block*` }),
    DocumentTitle,
    StarterKit.configure({
      // StarterKit's own Document is `block+`, which is both halves wrong.
      document: false,
      // Collaboration owns history through the shared Yjs undo manager, which
      // tracks only this client's transactions. Leaving StarterKit's own
      // history in place gives the editor a second, client-blind undo stack:
      // a peer's edit arrives as a local transaction there, so one Cmd+Z
      // deletes their paragraph. Verified by mutation — switching this back on
      // turns the document to an empty string in the per-client undo test.
      undoRedo: false,
      // TrailingNode appends a paragraph whenever the body's last block is not
      // one. Harmless in a private editor; in a shared document that append is
      // a WRITE. It broadcasts to everyone, it lands on the undo stack of
      // whoever opened the file, and it fires for a read-only viewer too —
      // `setEditable(false)` stops keystrokes, not a plugin's own
      // appendTransaction. The server drops a viewer's update without an error,
      // so that client sits permanently one paragraph ahead with nothing to
      // signal it.
      //
      // It also revives what the seeded body prevents: undo back past the
      // appended paragraph, click once, and it is re-appended as a fresh local
      // edit — clearing the redo stack and stranding the text just undone.
      //
      // What is lost is the convenience of always having a paragraph to click
      // after a trailing block. Building that back has to happen without
      // writing to the document — a rendered affordance that inserts only when
      // the user actually puts the caret in it — and belongs with the editing
      // slice, not here.
      trailingNode: false,
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
      undoManager,
      resolveCollaboratorName,
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
