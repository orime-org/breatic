// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document editor's extension list — and with it, its ProseMirror schema.
 *
 * **This slice delivers a collaborative surface, not an editor's feature set.**
 * The body binds to Yjs, carets appear, undo works, everything persists. What
 * users can WRITE into that body is plain text: paragraphs, and a line break.
 * Formatting, block structure and media are a separate body of work that
 * arrives whole in a later slice, together with its toolbar.
 *
 * That is why StarterKit is configured almost entirely off. Every switch below
 * turns off something StarterKit enables BY DEFAULT, and each default carries
 * an input rule with it — `# ` becomes a heading, `- ` a list, `> ` a quote,
 * three backticks a code block. A default nobody chose is still a feature users
 * can reach, and reaching it here has a real consequence: the undo manager
 * protects `paragraph` alone (see `document-undo.ts`), which is complete only
 * while a paragraph is all this document can hold.
 *
 * **What a later slice must do when it turns any of this back on:**
 *
 * 1. Register the node or mark AND its attributes. y-tiptap deletes anything
 *    its schema does not recognise — including an undeclared ATTRIBUTE on a
 *    node it otherwise knows — and commits that deletion as an ordinary local
 *    change, so it syncs to every peer and persists.
 * 2. Release the schema BEFORE shipping the UI that writes it. The client that
 *    destroys content is the one running the older bundle; giving it the schema
 *    first is what closes that window. How long the window is depends on how we
 *    deploy, which is a question that slice has to answer before it starts.
 * 3. Widen the undo manager's protected-node list to cover it.
 *
 * `__tests__/document-extensions.test.ts` holds those lists as a machine check.
 */

import type { Extensions } from '@tiptap/core';
import { Placeholder } from '@tiptap/extension-placeholder';
import StarterKit from '@tiptap/starter-kit';
import type * as Y from 'yjs';

import { t } from '@breatic/shared';

import type { CaretUserIdentity } from '@web/features/collab-editor/use-caret-user';
import { buildCollabExtensions } from '@web/features/collab-editor/collab-extensions';
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
 * Only the collaborative layers (binding, carets) and the placeholder are
 * conditional, and none of them contributes a node or mark — so the schema is
 * the same whether or not collaboration is active.
 * @param options - The body fragment plus the collaborative wiring.
 * @returns The full extension list, ready for `useEditor`.
 */
export function buildDocumentExtensions(
  options: DocumentExtensionOptions,
): Extensions {
  const { fragment, caretProvider, caretUser, undoManager } = options;

  const extensions: Extensions = [
    StarterKit.configure({
      // ── Block types — all of slice 2 onwards ──
      // Between them these ship the input rules that turn `# `, `- `, `1. `,
      // `> ` and three backticks into blocks, so leaving any on lets a user
      // create content this slice has no design for and whose undo is
      // unprotected. `listItem` has no rule of its own — it is the node the
      // list rules build with, and a list without it is not a list.
      heading: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      // Keyboard handling for lists that no longer exist. Off with them, rather
      // than left looking for node types the schema does not have.
      listKeymap: false,
      blockquote: false,
      codeBlock: false,
      horizontalRule: false,

      // ── Marks — all of slice 2 ──
      // Bold, italic and strike still have toolbar buttons on screen: the
      // toolbar keeps its final shape while the capability lands later, and the
      // buttons do nothing until it does. Registering the marks behind them
      // would make the capability reachable by keyboard shortcut regardless,
      // which is the state this whole configuration exists to avoid.
      bold: false,
      italic: false,
      strike: false,
      underline: false,
      code: false,
      link: false,

      // Collaboration owns history through the shared Yjs undo manager, which
      // tracks only this client's transactions. Leaving StarterKit's own
      // history in place gives the editor a second, client-blind undo stack:
      // a peer's edit arrives as a local transaction there, so one Cmd+Z
      // deletes their paragraph. Verified by mutation — switching this back on
      // turns the document to an empty string in the per-client undo test.
      undoRedo: false,
      // TrailingNode appends a paragraph whenever the body's last block is not
      // one, and in a shared document that append is a WRITE.
      //
      // **It cannot fire in this slice** — measured, by removing this line and
      // watching the extension really enter the tree while every test still
      // passed: a ProseMirror doc always holds at least one block, and a
      // paragraph is the only block type registered, so "the last block is not
      // a paragraph" is never true. Nothing observable changes today either
      // way, so `no-client-side-repair` does not cover it and says so.
      //
      // It is off regardless, because the slice that registers the first other
      // block type would otherwise inherit it switched on — and there it does
      // real damage: the append broadcasts, it lands on the undo stack of
      // whoever opened the file, and it fires for a read-only viewer too, since
      // `setEditable(false)` stops keystrokes rather than a plugin's own
      // appendTransaction. The server drops a viewer's update without an error,
      // so that client sits permanently one paragraph ahead with nothing to
      // signal it. It also revives what the seeded body prevents: undo back
      // past the appended paragraph, click once, and it is re-appended as a
      // fresh local edit — clearing the redo stack and stranding the text just
      // undone.
      //
      // What that slice gives up is the convenience of always having a
      // paragraph to click after a trailing table or image, and it has to build
      // that back without writing to the document — a rendered affordance that
      // inserts only when the user actually puts the caret in it.
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
