// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one place a document editor is assembled.
 *
 * Records mode receives the existing handle's runtime, native history and
 * origin. Its own binding and position adapters are selected before any XML
 * collaboration factory is invoked. Parsing shares the same product schema
 * and extensions while keeping all content local to the temporary editor.
 *
 * XML callers use `withCollaboration` with the same common extension options:
 * that wrapper merges its own extension arrays and replaces initialContent.
 * ProseMirror history stays disabled in the collaborative assemblies.
 *
 * ## Why the awareness is withheld
 *
 * `CollaborationOptions.user` is required, and `YCursorPlugin` writes it onto
 * awareness as soon as it can reach one — measured, one frame at construction.
 * The client never states who it is:
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

import { DocumentBodyBinding } from '@web/spaces/document/document-body-binding';
import type { DocumentBodyOptions } from '@web/spaces/document/document-body-binding-types';
import { buildDocumentSchema } from '@web/spaces/document/document-schema-blocknote';
import { documentNodeCompositionExtension } from '@web/spaces/document/document-node-composition';
import { documentDividerInputExtension } from '@web/spaces/document/document-divider';
import { documentBodyEdgePointerExtension } from '@web/spaces/document/document-body-edge-pointer';
import { documentDragAutoScrollExtension } from '@web/spaces/document/document-drag-autoscroll';
import { documentSelectionDragExtension } from '@web/spaces/document/document-selection-drag';
import { documentBodyEdgeExtension } from '@web/spaces/document/document-body-edge-selection';
import { documentMediaRowPressExtension } from '@web/spaces/document/document-media-row-press';
import { documentBodyFocusExtension } from '@web/spaces/document/document-body-focus';
import { documentBlankPressExtension } from '@web/spaces/document/document-body-press';
import { documentSelectionPaintExtension } from '@web/spaces/document/document-selection-paint';
import { documentEnterExtension } from '@web/spaces/document/document-enter';
import { documentKeyboardMoveExtension } from '@web/spaces/document/document-keyboard-move';
import { documentTabExtension } from '@web/spaces/document/document-tab';
import { documentTableKeysExtension } from '@web/spaces/document/document-table-keys';
import { documentTableColumnWidthsExtension } from '@web/spaces/document/document-table-column-widths';
import { documentTableTargetExtension } from '@web/spaces/document/document-table-target';
import { documentTableHandlesExtension } from '@web/spaces/document/document-table-handles';
import { documentTableCopyExtension } from '@web/spaces/document/document-table-copy';
import { documentTableSideMenuExtension } from '@web/spaces/document/document-table-side-menu';
import { documentTableLeaveSelectionExtension } from '@web/spaces/document/document-table-leave-selection';
import { STRIP_SIZE, TABLE_STRIP_OUTSET } from '@web/spaces/document/document-strip-alignment';
import { documentTableDragExtension, holdDropLineInTableDrags } from '@web/spaces/document/document-table-drag';
import { documentPasteHandler } from '@web/spaces/document/document-table-paste';
import { documentQuoteInputExtension } from '@web/spaces/document/document-quote-input';
import { documentSafariImeExtension } from '@web/spaces/document/document-safari-ime';
import { documentTrailingPressExtension } from '@web/spaces/document/document-trailing-press';
import { documentLinkEditMarkExtension } from '@web/spaces/document/document-link-edit-mark';
import { documentDragDropExtension } from '@web/spaces/document/document-drag-drop';
import { documentCommentMarkExtension } from '@web/spaces/document/document-comment-mark';
import {
  documentCommentsExtension,
  type DocumentCommentsOptions,
} from '@web/spaces/document/document-comment-thread-store';
import { documentCommentDraftRange } from '@web/spaces/document/document-comment-draft-range';
import { documentCommentPasteExtension } from '@web/spaces/document/document-comment-paste';
import { documentCommentSelection } from '@web/spaces/document/document-comment-selection';
import { documentNoNodeClickExtension } from '@web/spaces/document/document-no-node-click';
import { LINK_ANCHOR_SELECTOR } from '@web/spaces/document/document-link';
import {
  documentPastedMediaExtension,
  type PastedMediaOptions,
} from '@web/spaces/document/document-external-media';
import {
  documentFileDropExtension,
  fileDropPosition,
  filesPasteHandler,
  type FilesSink,
} from '@web/spaces/document/document-file-input';

/** What a caller has to supply to open a document. */
export interface DocumentEditorOptions {
  /** The shared fragment this editor binds to. */
  readonly fragment: Y.XmlFragment;
  /** Handle-owned records resources selected before any XML factory is called. */
  readonly body?: DocumentBodyOptions;
  /** Independent parsing uses the product schema without shared synchronization. */
  readonly mode?: 'parse';
  /** Extensions to register, the cross-version fallbacks among them. */
  readonly extensions?: readonly ExtensionFactoryInstance[];
  /**
   * Wires comments to this document, or leaves the body without them.
   *
   * Named rather than passed among `extensions` because it decides which of
   * two registrars brings the comment mark — see {@link commentWiring}.
   */
  readonly comments?: DocumentCommentsOptions;
  /**
   * Where files dropped or pasted into the body are handed over, with the gap
   * they go into (inner#1127 A2, A3). Left out, a dropped or pasted file does
   * nothing.
   */
  readonly onFiles?: FilesSink;
  /**
   * How pasted media are judged (inner#1127 A18). Left out, every pasted
   * medium is left out.
   */
  readonly media?: PastedMediaOptions;
}

/**
 * The class every body rule in `index.css` is written against, carried by the
 * editor element itself.
 *
 * It has to sit on THIS element rather than on an ancestor, because BlockNote
 * lifts pieces of the surface out of the editor and styles them by copying
 * this element's class list onto the copy: the drag preview is a clone of the
 * dragged block group, appended to `document.body` with every class of
 * `view.dom` except `ProseMirror`, `bn-root` and `bn-editor`
 * (`@blocknote/core`'s `SideMenu/dragging.ts` upstream, whose own
 * comment asks for a better way of doing exactly this). Scoped to the wrapper,
 * as these rules were until 2026-09-17, the clone matched none of them and the
 * floating copy of a dragged row was drawn in BlockNote's defaults — measured,
 * a level-1 heading lifted at 48px/72px against the 24px/31.2px it has in the
 * body, a paragraph at 16px against 15px, a numbered item with its number
 * gone, a quote with neither its colour nor its bar (task #113).
 *
 * The name is the surface, not the wrapper: `doc-body-editor` stays on the
 * column around it, which carries the layout, and this one carries the
 * typography. Keeping them apart is what stops the body's rules from reaching
 * the strip and the menus that hang inside that column.
 */
export const BODY_SURFACE_CLASS = 'doc-body';

/**
 * The user field `CollaborationOptions` requires.
 *
 * It never reaches awareness: without a `provider` the cursor plugin has
 * nowhere to write it. The values are the empty strings the type asks for.
 */
const UNUSED_USER = { name: '', color: '' } as const;

/**
 * Assembles the product schema over records, an XML fragment or local parsing.
 * @param options - The selected body resources and product extensions.
 * @returns The editor, not yet mounted.
 * @throws {Error} Whatever BlockNote throws while validating the options.
 */
export function buildDocumentEditor(
  options: DocumentEditorOptions,
): BlockNoteEditor<never, never, never> {
  const doc = options.fragment.doc;
  if (options.body !== undefined && doc === null) throw new Error('Records construction requires an attached content document');
  const binding = options.mode === 'parse' || options.body === undefined || doc === null ? null : new DocumentBodyBinding(doc, options.body);
  const common = {
    // The Enter binding goes in first so that a caller's extension can still
    // sit after it; the built-in list bindings it overrides are registered
    // with the blocks themselves.
    extensions: [
      documentEnterExtension(),
      documentSafariImeExtension(),
      documentTabExtension(),
      documentTableKeysExtension(),
      documentTableTargetExtension(),
      documentTableHandlesExtension(),
      documentTableCopyExtension(),
      documentTableSideMenuExtension(),
      documentTableLeaveSelectionExtension(),
      documentTableColumnWidthsExtension(),
      documentTableDragExtension(),
      documentKeyboardMoveExtension(),
      documentTrailingPressExtension(),
      documentQuoteInputExtension(),
      documentDividerInputExtension(),
      documentNodeCompositionExtension(),
      documentBodyEdgePointerExtension(),
      documentDragAutoScrollExtension(),
      documentSelectionDragExtension(),
      documentBodyEdgeExtension(),
      documentSelectionPaintExtension(),
      documentBodyFocusExtension(),
      documentBlankPressExtension(),
      documentMediaRowPressExtension(),
      documentLinkEditMarkExtension(),
      documentDragDropExtension(),
      documentNoNodeClickExtension(),
      // Ahead of the wiring: a press on two overlapping highlights has to be
      // answered before the library's own handler takes the first of them.
      documentCommentSelection(),
      commentWiring(options.comments === undefined || binding === null ? options.comments : {
        ...options.comments,
        canWrite: (): boolean => binding.canWrite() && options.comments?.canWrite?.() !== false,
      }),
      documentCommentPasteExtension(),
      documentCommentDraftRange(),
      documentFileDropExtension(options.onFiles),
      documentPastedMediaExtension(options.media),
      ...(options.extensions ?? []),
    ],
    disableExtensions: [
      // `documentFileDropExtension` takes file drops; the library's own would
      // take them first, at the DOM event, and insert nothing without an
      // `uploadFile` option (`fileDropExtension.ts:27-45`).
      'dropFile',
      // Ours draws the placeholder, from `document-placeholders-blocknote.ts`.
      'placeholder',
      // §14 keeps our own bubble bar, so BlockNote's is never drawn — and a
      // toolbar that is never drawn still tracks the selection: enabled, it
      // mounts, subscribes to every change and every selection change, and
      // each one walks a copy of the selected slice
      // (`FormattingToolbar.ts:11-46,52-72`). Nothing in this Space reads that
      // store; inside BlockNote only its own Tab and Shift-Tab bindings do,
      // and they decline the key while the toolbar judges it should be on
      // screen — a selection that is non-empty, holds text, and does not
      // reach into plain content like a code block — so a reader can tab
      // INTO the toolbar.
      'formattingToolbar',
    ],
  };
  const collaborative = options.mode === 'parse'
    ? { ...common, disableExtensions: ['history', ...common.disableExtensions] }
    : binding === null
      ? withCollaboration({ ...common, collaboration: { fragment: options.fragment, user: UNUSED_USER } })
      : {
        ...common,
        extensions: [binding.extension(), ...common.extensions, ...binding.compatibility()],
        disableExtensions: ['history', ...common.disableExtensions],
        initialContent: [{ type: 'paragraph', id: 'initialBlockId' }],
      };

  const editor = BlockNoteEditor.create({
    schema: buildDocumentSchema(),
    links: { onClick: openLinkInANewTab },
    domAttributes: { editor: { class: BODY_SURFACE_CLASS } },
    // The line that says where a dragged block will land. Withholding the
    // colour is what lets `index.css` paint it: given one, the extension
    // writes `#ddeeff` inline onto the element
    // (`extensions/DropCursor/DropCursor.ts:121-122`), and an inline style
    // beats any rule of ours — so the affordance would keep a fixed light
    // blue that follows neither theme nor our tokens. `false` is the
    // extension's own way of saying "class only".
    // The width is here rather than in CSS because it is geometry, not paint:
    // the extension centres a bar of this thickness on the boundary between
    // two blocks and writes the height inline. Five, which it defaults to,
    // draws a band across the whole 768px column; two reads as a line, which
    // is all this has to say and is how the rest of this product's chrome is
    // drawn.
    dropCursor: { color: false, width: 2, hooks: { computeDropPosition: holdDropLineInTableDrags(fileDropPosition) } },
    // The gutter left of the body counts as the row beside it, as far out as
    // a strip stands, a table's own being the furthest: it is reached there,
    // level with the table and past its first column's strips, since over its
    // cells the strip belongs to their blocks (inner#1619 design 5.3).
    sideMenu: { hoverMargin: TABLE_STRIP_OUTSET + STRIP_SIZE },
    pasteHandler:
      options.onFiles === undefined
        ? documentPasteHandler
        : filesPasteHandler(options.onFiles, documentPasteHandler),
    ...collaborative,
  } as never) as BlockNoteEditor<never, never, never>;
  if (binding !== null) {
    // TipTap installs plugins only in createView. The cache constructs this
    // editor before mounting, so install that same plugin set before the first
    // source projection; mounting later retains their state by plugin key.
    const tiptap = editor._tiptapEditor;
    tiptap.view.updateState(tiptap.state.reconfigure({ plugins: tiptap.extensionManager.plugins }));
  }
  binding?.initialize(editor);
  return editor;
}

/**
 * Registers the comment mark, with a thread store behind it or without one.
 *
 * The mark is in the schema either way: `DOCUMENT_SCHEMA_VERSION` is this
 * build's vocabulary, and a mark that came and went with a runtime option
 * would make the vocabulary depend on how the editor happened to be
 * constructed. What the wiring decides is which extension registers it — the
 * library's own brings the same `CommentMark`, and tiptap keeps every copy it
 * is handed, warning about the duplicate name for the life of the editor.
 * @param comments - The thread-store wiring, or undefined for a body with no
 *   comments behind it.
 * @returns The extension that puts `comment` in the schema.
 */
function commentWiring(
  comments: DocumentCommentsOptions | undefined,
): ExtensionFactoryInstance {
  return comments === undefined
    ? documentCommentMarkExtension()
    : documentCommentsExtension(comments);
}

/**
 * Opens a pressed link, with no handle back to this tab.
 *
 * The implicit `noopener` the HTML spec gives `<a target=_blank>` covers
 * navigations, not a `window.open` call — and the factory handler opens a link
 * with `window.open(href, target)`
 * (grep `window.open` in `@blocknote/core/dist/blocknote.js`),
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
 * (upstream's `Link/helpers/clickHandler.ts` returns nothing there).
 * @param event - The press, which the handler has already matched to a link.
 */
function openLinkInANewTab(event: MouseEvent): void {
  const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
    LINK_ANCHOR_SELECTOR,
  );
  const href = anchor?.getAttribute('href');
  if (href) window.open(href, '_blank', 'noopener,noreferrer');
}
