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

import {
  blockToNode,
  createExtension,
  type BlockNoteEditorOptions,
  type ExtensionFactoryInstance,
} from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, type EditorState } from '@tiptap/pm/state';

import { landingFor } from '@web/spaces/document/document-drag-move';
import { QUOTED } from '@web/spaces/document/document-list-block';
import type { SlotAnchor } from '@web/spaces/document/document-upload-slots';

/** BlockNote's paste hook, as this editor's options take it. */
export type PasteHandler = NonNullable<
  BlockNoteEditorOptions<never, never, never>['pasteHandler']
>;

/** Files that arrived, with the gap they go into. */
export interface FilesArrival {
  readonly files: readonly File[];
  readonly anchor: SlotAnchor;
  /** Whether what lands there sits in a quote. */
  readonly quoted: boolean;
}

/** Where arriving files are handed over. */
export type FilesSink = (arrival: FilesArrival) => void;

/** A gap and the quoting what lands in it takes. */
export interface FileGap {
  readonly anchor: SlotAnchor;
  readonly quoted: boolean;
}

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
 * Whether a block's own node sits in a quote.
 * @param container - A block container.
 * @returns True when quoted.
 */
function quotedOf(container: PMNode | null | undefined): boolean {
  return container?.firstChild?.attrs[QUOTED] === true;
}

/**
 * The gap at a position between two blocks.
 * @param doc - The document.
 * @param at - A position between two block containers.
 * @returns The gap; its quoting is the block's above, or the one below at the
 *   head of a level.
 */
function gapAt(doc: PMNode, at: number): FileGap {
  const $at = doc.resolve(at);
  const before = $at.nodeBefore;
  const after = $at.nodeAfter;
  return {
    anchor: {
      before: (before?.attrs['id'] as string | undefined) ?? null,
      after: (after?.attrs['id'] as string | undefined) ?? null,
    },
    quoted: before !== null ? quotedOf(before) : quotedOf(after),
  };
}

/**
 * The gap a drop at a document position lands in: the same one a dragged
 * row would land in there.
 * @param doc - The document.
 * @param at - The position the pointer is over.
 * @returns The gap.
 */
export function anchorAtGap(doc: PMNode, at: number): FileGap {
  const probe = blockToNode({ type: 'paragraph' } as never, doc.type.schema);
  return gapAt(doc, landingFor(doc, at, probe));
}

/**
 * The gap a paste of files goes into: after the block the caret is in, or
 * above it when it is an empty line, which keeps the caret.
 * @param state - The editor state.
 * @returns The gap.
 */
export function anchorAtCaret(state: EditorState): FileGap {
  const { $head } = state.selection;
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    const container = $head.node(depth);
    if (container.type.name !== 'blockContainer') continue;
    const start = $head.before(depth);
    const emptyLine =
      container.firstChild?.isTextblock === true && container.firstChild.content.size === 0;
    return gapAt(state.doc, emptyLine ? start : start + container.nodeSize);
  }
  return gapAt(state.doc, state.doc.content.size - 1);
}

/**
 * Whether a drag carries files from outside the page.
 * @param event - The drag event.
 * @returns True when it does.
 */
export function carriesFiles(event: Event): boolean {
  const { dataTransfer } = event as Partial<DragEvent>;
  return dataTransfer?.types.includes('Files') === true;
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
            // Taken in a read-only body too, and over a media block's own
            // controls: a file drag whose `dragover` nobody cancels gets no
            // `drop`, and the browser opens the file in place of the page.
            dragover: (view, event) => {
              if (view.dragging !== null || !carriesFiles(event)) return false;
              event.preventDefault();
              if (!view.editable && event.dataTransfer !== null) event.dataTransfer.dropEffect = 'none';
              return !view.editable;
            },
            drop: (view, event) => {
              if (view.dragging !== null || !carriesFiles(event)) return false;
              // The browser opens a dropped file in place of the page unless
              // the drop is taken, read-only or not.
              event.preventDefault();
              if (!view.editable) return true;
              const files = Array.from(event.dataTransfer?.files ?? []);
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (sink === undefined || files.length === 0 || at === null) return true;
              sink({ files, ...anchorAtGap(view.state.doc, at.pos) });
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
      sink({ files, ...anchorAtCaret(view.state) });
    }
    return true;
  };
}
