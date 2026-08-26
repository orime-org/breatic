// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The document editor's extension list.
 *
 * **What a user can write into the body is StarterKit's, save for two named
 * departures.** Every list, quote, code block and mark it ships behaves exactly
 * as it would on its own, because the editing feature set is a separate body of
 * work with its own slice. The two exceptions: the body offers three heading
 * levels rather than six (`document-heading` carries that reasoning), and it
 * offers no divider yet (its return, with the selected-look for text-less
 * blocks it requires, is scheduled work — task #124).
 *
 * So a change here qualifies on one of three grounds, and nothing else counts:
 *
 * - the document's outer shape broke something — a document that may hold
 *   nothing at all;
 * - what the body renders leaves no room for what StarterKit offers, which is
 *   what caps the headings;
 * - the feature itself was never decided on. A StarterKit default is a default,
 *   not a decision, and one that costs something to keep has to earn its place
 *   like anything else would.
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
import { DocumentSelectAll } from '@web/spaces/document/document-select-all';
import { DocumentSplitBlock } from '@web/spaces/document/document-split-block';
import { LocaleRedraw } from '@web/spaces/document/locale-redraw';

/**
 * What an address typed without one is stored as.
 *
 * The href reaches every peer and the markdown export, so a bare `breatic.ai`
 * is qualified before it is written. Both paths that write one read this: the
 * extension recognising a URL as it is typed, and the popover normalising what
 * was pasted into it.
 */
export const DEFAULT_LINK_PROTOCOL = 'https';

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
  /**
   * Called instead of deleting when Backspace or Delete lands on a
   * whole-document selection; the host confirms and runs `clearDocument`.
   * See `document-select-all` for why absence swallows the key rather than
   * widening into a silent wipe.
   */
  onClearDocumentRequest?: () => void;
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
  const {
    fragment,
    caretProvider,
    undoManager,
    resolveCollaboratorName,
    onClearDocumentRequest,
  } = options;

  const extensions: Extensions = [
    // `block*` — any number of blocks INCLUDING none. Emptiness being legal is
    // what makes the shared fragment safe: no client ever invents a filler
    // block to satisfy the schema, so there is nothing for a merge to
    // duplicate. `@breatic/shared`'s `document-body` carries the reasoning;
    // the empty document's interaction (placeholder, click, first keystroke)
    // is `DocumentPlaceholders` and `DocumentClickToWrite` below.
    Document.extend({ content: 'block*' }),
    // The select-all tiers, the guarded whole-document delete, the
    // whole-document Enter, and the degenerate-selection guard — the ruled
    // transition tables live in the structure decision record.
    DocumentSelectAll.configure({
      onClearDocumentRequest: onClearDocumentRequest ?? null,
    }),
    // The document may hold no blocks at all, so the empty space has to be
    // clickable or a fresh document cannot be written into by mouse.
    DocumentClickToWrite,
    // Enter across two list items throws in @tiptap/core's own splitBlock,
    // which asks whether it may split before deleting and then splits what the
    // deletion left. This replaces that command with the official one, whose
    // order is the other way round. Carries no priority on purpose — commands
    // merge with the lower priority winning, the opposite of key bindings.
    DocumentSplitBlock,
    StarterKit.configure({
      // StarterKit's own Document is `block+`, which would re-open the
      // filler-block hazard emptiness closes.
      document: false,
      // Collaboration owns history through the shared Yjs undo manager, which
      // tracks only this client's transactions. Leaving StarterKit's own
      // history in place gives the editor a second, client-blind undo stack:
      // a peer's edit arrives as a local transaction there, so one Cmd+Z
      // deletes their paragraph. Verified by mutation — switching this back on
      // wipes the body in the per-client undo tests: the peer's paragraph
      // disappears.
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
      // The divider is not offered yet. It was removed when "everything
      // visible can be selected" priced a text-less block out; the structure
      // ruling brings it back TOGETHER with the selected-look such a block
      // needs inside a drag selection, and that pairing is task #124 — not a
      // one-line re-enable here.
      horizontalRule: false,
      link: {
        // A click on a link places the caret and selects the whole link, which
        // is how an editor reaches one with the mouse. The default opens a new
        // window instead, taking the click the caret needs.
        openOnClick: false,
        enableClickSelection: true,
        // The extension's own default is http. It writes hrefs the same way
        // the link popover does — a URL typed into the body becomes a link on
        // the next space — so the two read one constant and cannot disagree
        // about what an address without a protocol means.
        defaultProtocol: DEFAULT_LINK_PROTOCOL,
      },
    }),
    BodyHeading,
    // Somewhere to put content this build has no vocabulary for. Registered
    // now, while there is nothing to catch: a fallback only works if the
    // client that meets the unknown content already has it, and the tabs this
    // whole problem is about are the ones already open. The retired `title`
    // block of the pre-ruling structure lands here too, in documents seeded
    // before the change.
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

  // The placeholder is drawn by `DocumentPlaceholders` rather than by the
  // extension every other editor uses: that one decorates textblocks that
  // exist, so a document with no blocks could never show one. Resolving the
  // string per decoration reads the live locale; `LocaleRedraw` asks for the
  // redraw, since switching language dispatches nothing on its own.
  extensions.push(DocumentPlaceholders, LocaleRedraw);

  return extensions;
}
