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

import { newId } from '@breatic/shared';

import { carriesFiles } from '@web/lib/stray-file-drop';
import {
  blockToNode,
  createExtension,
  type BlockNoteEditorOptions,
  type ComputeDropPositionContext,
  type ExtensionFactoryInstance,
} from '@blocknote/core';
import { Fragment, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model';
import { Plugin, type EditorState, type Transaction } from '@tiptap/pm/state';

import { landingFor } from '@web/spaces/document/document-drag-move';
import { QUOTED } from '@web/spaces/document/document-list-block';
import { HTML_MEDIA_SELECTOR } from '@web/spaces/document/document-media-types';

/** A position between two blocks, where inserted blocks go. */
export type UploadGap = number;

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
    elements[0]!.matches(HTML_MEDIA_SELECTOR) &&
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

/** Where a paste of files goes, and whether the reader aimed it at a line. */
export interface PasteTarget {
  readonly gap: UploadGap;
  /** The caret is in an empty line and the gap is right above it. */
  readonly aimed: boolean;
}

/**
 * Where a paste goes: after the block a position is in, or above it when it
 * is an empty line, which keeps the caret and counts as aimed at it. In a
 * table cell the block is the whole table, so the gap is below it.
 * @param state - The editor state.
 * @param $at - The position; the caret's when left out.
 * @returns The gap, and whether it is aimed at the empty line.
 */
export function pasteTarget(state: EditorState, $at: ResolvedPos = state.selection.$head): PasteTarget {
  const line = lineAt($at);
  if (line === null) return { gap: state.doc.content.size - 1, aimed: false };
  if (line.empty) return { gap: line.start, aimed: true };
  return { gap: line.start + line.container.nodeSize, aimed: false };
}

/**
 * The block a position is in, and whether it is an empty line.
 * @param $at - The position.
 * @returns The block's start and node, or null outside any block.
 */
function lineAt($at: ResolvedPos): { start: number; container: PMNode; empty: boolean } | null {
  for (let depth = $at.depth; depth > 0; depth -= 1) {
    const container = $at.node(depth);
    if (container.type.name !== 'blockContainer') continue;
    const empty = container.firstChild?.isTextblock === true && container.firstChild.content.size === 0;
    return { start: $at.before(depth), container, empty };
  }
  return null;
}

/**
 * Whether a position is inside a table cell.
 * @param $at - The position.
 * @returns True when one of its ancestors is a cell.
 */
export function inTableCell($at: ResolvedPos): boolean {
  for (let depth = $at.depth; depth > 0; depth -= 1) {
    const name = $at.node(depth).type.name;
    if (name === 'tableCell' || name === 'tableHeader') return true;
  }
  return false;
}

/** A block to insert, as BlockNote takes one. */
export interface BlockSpec {
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly content?: unknown;
}

/**
 * Blocks quoted as the line they go beside: the schema's default is
 * `quoted: false` (`document-schema-blocknote.ts:53`), and a block made
 * inside a quote stays in it, the way Enter's does.
 * @param blocks - The blocks.
 * @param quoted - Whether that line is quoted.
 * @returns The blocks, quoted as it.
 */
export function quotedAs(blocks: readonly BlockSpec[], quoted: boolean): BlockSpec[] {
  return blocks.map((block) => ({ ...block, props: { ...block.props, [QUOTED]: quoted } }));
}

/**
 * Whether the line beside a gap is quoted: the line the reader aimed at,
 * else the block before the gap (the block after it at the start of the
 * body) — the way a block made there by typing would be.
 * @param doc - The document.
 * @param gap - The gap.
 * @param aimed - Whether the reader aimed at the line right after the gap.
 * @returns True when that line is quoted.
 */
function quotedBeside(doc: PMNode, gap: UploadGap, aimed: boolean): boolean {
  const $gap = doc.resolve(gap);
  const beside: PMNode | null = aimed ? $gap.nodeAfter : ($gap.nodeBefore ?? $gap.nodeAfter);
  return beside?.firstChild?.attrs[QUOTED] === true;
}

/**
 * A transaction inserting blocks at a gap, quoted as the line beside it.
 * @param state - The state they go into.
 * @param gap - Where they go.
 * @param aimed - Whether the reader aimed at the line right after the gap.
 * @param blocks - The blocks, in order.
 * @returns The transaction.
 */
export function insertAtGapTr(
  state: EditorState,
  gap: UploadGap,
  aimed: boolean,
  blocks: readonly BlockSpec[],
): Transaction {
  const nodes = quotedAs(blocks, quotedBeside(state.doc, gap, aimed)).map((block) =>
    blockToNode({ id: newId(), ...block } as never, state.schema),
  );
  return state.tr.insert(gap, Fragment.from(nodes));
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
      sink({ files, ...pasteTarget(view.state) });
    }
    return true;
  };
}
