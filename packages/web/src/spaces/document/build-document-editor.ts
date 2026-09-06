// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one place a document editor is assembled.
 *
 * `withCollaboration` merges `extensions` and `disableExtensions` from ITS OWN
 * argument object and overwrites `initialContent`. Anything we want in those
 * three keys therefore has to travel THROUGH it — spreading our own value
 * beside the call loses one side or the other, silently and in opposite
 * directions depending on the order. Measured on real editors:
 *
 * ```
 * ours before the spread : placeholder plugin survives, ours draws a second one
 * ours after the spread  : "history" is dropped, prosemirror-history runs
 *                          alongside y-undo on a Yjs document
 * ```
 *
 * ## Why the awareness is withheld
 *
 * `CollaborationOptions.user` is required, and `YCursorPlugin` writes it onto
 * awareness as soon as it can reach one — measured, one frame at construction.
 * The delivered invariant (#1886) is that this client never states who it is:
 * the server writes the id from the validated credential, and a client that
 * announced its own would be announcing something nobody verified.
 *
 * The plugin reaches awareness only through `provider`, so not passing one
 * makes that write structurally impossible rather than a race to undo it.
 * BlockNote's cursor extension then registers nothing, and remote carets are
 * drawn by the plugin we register ourselves.
 */

import {
  BlockNoteEditor,
  type ExtensionFactoryInstance,
} from '@blocknote/core';
import { withCollaboration } from '@blocknote/core/yjs';
import type * as Y from 'yjs';

import { buildDocumentSchema } from '@web/spaces/document/document-schema-blocknote';
import {
  documentEnterExtension,
  documentTabExtension,
} from '@web/spaces/document/document-enter';
import { documentQuoteInputExtension } from '@web/spaces/document/document-quote-input';
import { documentLinkClickExtension } from '@web/spaces/document/document-link-click';

/** What a caller has to supply to open a document. */
export interface DocumentEditorOptions {
  /** The shared fragment this editor binds to. */
  readonly fragment: Y.XmlFragment;
  /** Extensions to register, the cross-version fallbacks among them. */
  readonly extensions?: readonly ExtensionFactoryInstance[];
}

/**
 * The user field `CollaborationOptions` requires.
 *
 * It never reaches awareness: without a `provider` the cursor plugin has
 * nowhere to write it. The values are the empty strings the type asks for.
 */
const UNUSED_USER = { name: '', color: '' } as const;

/**
 * Assembles a document editor over a shared fragment.
 * @param options - The fragment to bind to and the extensions to register.
 * @returns The editor, not yet mounted.
 * @throws {Error} Whatever BlockNote throws while validating the options.
 */
export function buildDocumentEditor(
  options: DocumentEditorOptions,
): BlockNoteEditor<never, never, never> {
  const collaborative = withCollaboration({
    collaboration: {
      fragment: options.fragment,
      user: UNUSED_USER,
    },
    // The Enter binding goes in first so that a caller's extension can still
    // sit after it; the built-in list bindings it overrides are registered
    // with the blocks themselves.
    extensions: [
      documentEnterExtension(),
      documentTabExtension(),
      documentLinkClickExtension(),
      documentQuoteInputExtension(),
      ...(options.extensions ?? []),
    ],
    disableExtensions: [
      // Ours draws the placeholder, from `document-placeholders-blocknote.ts`.
      'placeholder',
      // The block handle it drags is #113; until then it draws nothing while
      // still tracking every pointer move, and `elementsFromPoint` — which it
      // calls on each one — is a DOM method jsdom does not implement, so the
      // exception it raises reaches the test runner from anywhere in the suite
      // that renders a document.
      'sideMenu',
    ],
  });

  return BlockNoteEditor.create({
    schema: buildDocumentSchema(),
    ...collaborative,
  } as never) as BlockNoteEditor<never, never, never>;
}
