// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Files arriving in a document body by drop or paste (inner#1127 A2, A3).
 *
 * Neither entry inserts anything. Each works out the gap the files go into and
 * hands both to `onFiles`, which the editor is built with; the page behind it
 * admits and uploads them (`document-uploads.ts`). A read-only body hands
 * nothing over (A11).
 *
 * BlockNote's own file drop is turned off in the assembly: it takes every drop
 * that carries files at the DOM event and inserts through an `uploadFile`
 * option this editor does not have (`fileDropExtension.ts:27-45`).
 */

import { carriesFiles } from '@web/lib/stray-file-drop';
import {
  blockToNode,
  createExtension,
  type BlockNoteEditorOptions,
  type ComputeDropPositionContext,
  type ExtensionFactoryInstance,
} from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, type EditorState } from '@tiptap/pm/state';

import { landingFor } from '@web/spaces/document/document-drag-move';
import type { UploadGap } from '@web/spaces/document/document-upload-slots';

/** BlockNote's paste hook, as this editor's options take it. */
export type PasteHandler = NonNullable<
  BlockNoteEditorOptions<never, never, never>['pasteHandler']
>;

/** Files that arrived, with the gap they go into. */
export interface FilesArrival {
  readonly files: readonly File[];
  readonly gap: UploadGap;
  /** Whether the files were aimed at the empty line right after the gap. */
  readonly aimed: boolean;
}

/** Where arriving files are handed over. */
export type FilesSink = (arrival: FilesArrival) => void;

/** The elements a browser's "copy image" puts in the HTML beside the file. */
const MEDIA_ELEMENTS = new Set(['IMG', 'VIDEO', 'AUDIO']);

/**
 * The files a paste carries, when the paste is the files.
 *
 * It is when nothing else came with them, or when the HTML beside them is
 * a single image, video or audio element — what a browser's "copy image"
 * writes. Anything else — a table copied from a spreadsheet arrives with a
 * rendered picture of itself — is HTML, pasted as such.
 * @param data - The clipboard.
 * @returns The files, or null when this paste is not one of files.
 */
export function pastedFiles(data: DataTransfer): File[] | null {
  const files = Array.from(data.files);
  if (files.length === 0) return null;
  const html = data.getData('text/html');
  if (html === '') return files;
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const elements = Array.from(body.children);
  const onlyMedia =
    elements.length === 1 &&
    MEDIA_ELEMENTS.has(elements[0]!.tagName) &&
    body.textContent?.trim() === '';
  return onlyMedia ? files : null;
}

/**
 * The gap a drop at a document position lands in: the place a dragged row
 * would land there.
 * @param doc - The document.
 * @param at - The position the pointer is over.
 * @returns The gap.
 */
export function gapAtDrop(doc: PMNode, at: number): UploadGap {
  return landingFor(doc, at, blockToNode({ type: 'paragraph' } as never, doc.type.schema));
}

/**
 * The drop line a drag of files shows (A2): at the gap the files land in, the
 * line a dragged row shows there; none over a read-only body, where the drop
 * does nothing. Every other drag keeps the line the editor draws.
 * @param context - The drag, as the drop line extension hands it.
 * @returns The line, or null for none.
 */
export function fileDropPosition(context: ComputeDropPositionContext): ComputeDropPositionContext['defaultPosition'] {
  const { view, event, defaultPosition } = context;
  if (view.dragging !== null || !carriesFiles(event)) return defaultPosition;
  if (!view.editable || defaultPosition === null) return null;
  return { pos: gapAtDrop(view.state.doc, defaultPosition.pos), orientation: 'block-horizontal' };
}

/**
 * The gap a paste of files goes into: after the block the caret is in, or
 * above it when it is an empty line, which keeps the caret.
 * @param state - The editor state.
 * @returns The gap.
 */
export function gapAtCaret(state: EditorState): UploadGap {
  const line = caretLine(state);
  if (line === null) return state.doc.content.size - 1;
  return line.empty ? line.start : line.start + line.container.nodeSize;
}

/**
 * The block the caret is in, and whether it is an empty line.
 * @param state - The editor state.
 * @returns The block's start and node, or null outside any block.
 */
function caretLine(state: EditorState): { start: number; container: PMNode; empty: boolean } | null {
  const { $head } = state.selection;
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    const container = $head.node(depth);
    if (container.type.name !== 'blockContainer') continue;
    const empty = container.firstChild?.isTextblock === true && container.firstChild.content.size === 0;
    return { start: $head.before(depth), container, empty };
  }
  return null;
}

/**
 * The drop entry. Without a sink a dropped file is still taken, so the
 * browser never opens it in place of the page, and goes nowhere.
 * @param sink - Where arriving files go, when the body uploads them.
 * @returns The extension, for the assembly to register.
 */
export function documentFileDropExtension(sink?: FilesSink): ExtensionFactoryInstance {
  return createExtension(() => ({
    key: 'documentFileDrop',
    prosemirrorPlugins: [
      new Plugin({
        props: {
          handleDOMEvents: {
            // A read-only body leaves its file drops to the window's guard
            // (`stray-file-drop.ts`), which keeps the browser from opening
            // the file.
            drop: (view, event) => {
              if (view.dragging !== null || !view.editable || !carriesFiles(event)) return false;
              event.preventDefault();
              const files = Array.from(event.dataTransfer?.files ?? []);
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (sink === undefined || files.length === 0 || at === null) return true;
              sink({ files, gap: gapAtDrop(view.state.doc, at.pos), aimed: false });
              return true;
            },
          },
        },
      }),
    ],
  }) as never)();
}

/**
 * The paste entry, in front of the editor's own paste.
 * @param sink - Where arriving files go.
 * @param next - The paste every other clipboard goes to.
 * @returns BlockNote's paste hook.
 */
export function filesPasteHandler(sink: FilesSink, next: PasteHandler): PasteHandler {
  return (context) => {
    const data = context.event.clipboardData;
    const files = data === null ? null : pastedFiles(data);
    if (files === null) return next(context);
    const view = context.editor.prosemirrorView;
    if (view !== undefined && view !== null) {
      sink({ files, gap: gapAtCaret(view.state), aimed: caretLine(view.state)?.empty === true });
    }
    return true;
  };
}
