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
import { documentEnterExtension } from '@web/spaces/document/document-enter';
import { documentTabExtension } from '@web/spaces/document/document-tab';
import { documentQuoteInputExtension } from '@web/spaces/document/document-quote-input';
import { documentSafariImeExtension } from '@web/spaces/document/document-safari-ime';
import { documentTrailingPressExtension } from '@web/spaces/document/document-trailing-press';
import { documentLinkEditMarkExtension } from '@web/spaces/document/document-link-edit-mark';
import { LINK_ANCHOR_SELECTOR } from '@web/spaces/document/document-link';

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
      documentSafariImeExtension(),
      documentTabExtension(),
      documentTrailingPressExtension(),
      documentQuoteInputExtension(),
      documentLinkEditMarkExtension(),
      ...(options.extensions ?? []),
    ],
    disableExtensions: [
      // Ours draws the placeholder, from `document-placeholders-blocknote.ts`.
      'placeholder',
      // §14 keeps our own bubble bar, so BlockNote's is never drawn — and a
      // toolbar that is never drawn still tracks the selection: enabled, it
      // mounts, subscribes to every change and every selection change, and
      // each one walks a copy of the selected slice
      // (`FormattingToolbar.ts:11-46,52-72`). Nothing in this Space reads that
      // store; inside BlockNote only its own Tab binding does
      // (`KeyboardShortcutsExtension.ts:963`), which declines the key for
      // every non-empty selection so a reader can tab INTO the toolbar.
      'formattingToolbar',
    ],
  });

  return BlockNoteEditor.create({
    schema: buildDocumentSchema(),
    links: { onClick: openLinkInANewTab },
    ...collaborative,
  } as never) as BlockNoteEditor<never, never, never>;
}

/**
 * Opens a pressed link, with no handle back to this tab.
 *
 * The implicit `noopener` the HTML spec gives `<a target=_blank>` covers
 * navigations, not a `window.open` call — and the factory handler opens a link
 * with `window.open(href, target)`
 * (`@blocknote/core/src/extensions/tiptap-extensions/Link/helpers/clickHandler.ts:73`),
 * so the opened page would keep `window.opener` and could send this tab
 * anywhere it liked. Addresses in a shared document come from co-editors and
 * from pastes.
 *
 * What is opened is the attribute, not the `href` property. An address this
 * build refuses — a peer's client can hold one, ours cannot write one — is
 * rendered as `href=""` (`.../Link/link.ts:119-126`), and an empty href
 * RESOLVES to this document's own address, so the property hands back the app's
 * URL and the press would open a second editor session holding a writable
 * collab seat.
 *
 * Returning nothing marks the press handled
 * (`.../Link/helpers/clickHandler.ts:66`).
 * @param event - The press, which the handler has already matched to a link.
 */
function openLinkInANewTab(event: MouseEvent): void {
  const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
    LINK_ANCHOR_SELECTOR,
  );
  const href = anchor?.getAttribute('href');
  if (href) window.open(href, '_blank', 'noopener,noreferrer');
}
