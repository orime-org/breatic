// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document editor's extension list.
 *
 * **What a user can write into the body is StarterKit's, save for two named
 * departures.** Every list, quote, code block and mark it ships behaves exactly
 * as it would on its own, because the editing feature set is a separate body of
 * work with its own slice. The two exceptions: the body offers three heading
 * levels rather than six (`document-heading` carries that reasoning), and it
 * offers no divider at all.
 *
 * So a change here qualifies on one of three grounds, and nothing else counts:
 *
 * - the document's outer shape broke something — a title that cannot be
 *   removed, followed by a body that may hold nothing;
 * - what the body renders leaves no room for what StarterKit offers, which is
 *   what caps the headings;
 * - the feature itself was never decided on. A StarterKit default is a default,
 *   not a decision, and one that costs something to keep has to earn its place
 *   like anything else would. That is what removed the divider.
 *
 * Five of StarterKit's defaults are switched off, each for its own reason
 * stated where it happens. `document-extensions.test` pins the NODES the
 * schema gains AND the ones it removes, along with the StarterKit switches, so
 * none of those can change quietly. An extension that contributes no node is
 * not pinned by it — the bar stated above is the only thing holding that line.
 */

import type { Extensions } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import StarterKit from '@tiptap/starter-kit';
import type * as Y from 'yjs';

import { DOCUMENT_TITLE_NODE } from '@breatic/shared';

import { buildCollabExtensions } from '@web/features/collab-editor/collab-extensions';
import type { ResolveCollaboratorName } from '@web/features/collab-editor/caret-render';
import { DocumentClickToWrite } from '@web/spaces/document/document-click-to-write';
import { BodyHeading } from '@web/spaces/document/document-heading';
import {
  UnsupportedBlock,
  UnsupportedInline,
  UnsupportedMark,
} from '@web/spaces/document/document-unsupported';
import { DocumentPlaceholders } from '@web/spaces/document/document-placeholders';
import { DocumentSelection } from '@web/spaces/document/document-selection';
import { DocumentSplitBlock } from '@web/spaces/document/document-split-block';
import { DocumentTitle } from '@web/spaces/document/document-title';
import { DocumentTitleIsPlainText } from '@web/spaces/document/document-title-plain-text';
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
    // The title holds text and nothing else, so a rule that would turn typed
    // text into a block must not fire there — the divider rule does not check
    // for itself and destroys what was typed.
    DocumentTitleIsPlainText,
    // The body may hold no blocks at all, so the space under the title has to
    // be clickable or a fresh document cannot be written into.
    DocumentClickToWrite,
    // A selection never spans the title and the body, whether it was made
    // with `Mod-a` or with the mouse. Ours because the title is the first
    // block of this same document, so the editor's own "select everything"
    // includes the document's name — see `document-selection`.
    DocumentSelection,
    // Enter across two list items throws in @tiptap/core's own splitBlock,
    // which asks whether it may split before deleting and then splits what the
    // deletion left. This replaces that command with the official one, whose
    // order is the other way round. Carries no priority on purpose — commands
    // merge with the lower priority winning, the opposite of key bindings.
    DocumentSplitBlock,
    StarterKit.configure({
      // StarterKit's own Document is `block+`, which is both halves wrong.
      document: false,
      // Collaboration owns history through the shared Yjs undo manager, which
      // tracks only this client's transactions. Leaving StarterKit's own
      // history in place gives the editor a second, client-blind undo stack:
      // a peer's edit arrives as a local transaction there, so one Cmd+Z
      // deletes their paragraph. Verified by mutation — switching this back on
      // wipes the body in the per-client undo tests: the peer's paragraph goes
      // and the title is all that is left.
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
      // What that costs is the convenience of always having a paragraph to
      // click after a trailing block. `DocumentClickToWrite` above gives it
      // back on the only terms a shared document allows: it writes when the
      // user actually clicks the space, and never for a viewer.
      trailingNode: false,
      // The body caps headings at three levels and answers for what happens to
      // a heading stored below that. The cap alone would be a `configure` away
      // — StarterKit forwards this option straight to `Heading.configure` — but
      // the answer lives in Heading's own `renderHTML` and takes an `extend`,
      // and StarterKit builds its Heading internally, where there is nothing to
      // extend. So ours replaces it. `document-heading` carries the reasoning.
      heading: false,
      // The divider is not a feature this document offers. It arrived as a
      // StarterKit default rather than as a decision, and it is the only
      // visible block in the body with no text in it — which is what made
      // "everything visible can be selected" cost a selection type of our own,
      // a patched y-tiptap, and a block-tinting layer, all to give a block
      // nobody asked for the same selected look as the rest. Removing it
      // removes the whole question. With it gone, every visible block holds
      // text, so an ordinary `TextSelection` covers all of them.
      horizontalRule: false,
    }),
    BodyHeading,
    // Somewhere to put content this build has no vocabulary for. Registered
    // now, while there is nothing to catch: a fallback only works if the
    // client that meets the unknown content already has it, and the tabs this
    // whole problem is about are the ones already open.
    UnsupportedBlock,
    UnsupportedInline,
    UnsupportedMark,
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

  // Both placeholders are drawn by `DocumentPlaceholders` rather than by the
  // extension every other editor uses: that one decorates textblocks that
  // exist and, by default, only the one holding the caret — so a body with no
  // blocks could never show one, and a fresh document could not show both.
  // Resolving the strings per decoration reads the live locale; `LocaleRedraw`
  // asks for the redraw, since switching language dispatches nothing on its
  // own.
  extensions.push(DocumentPlaceholders, LocaleRedraw);

  return extensions;
}
