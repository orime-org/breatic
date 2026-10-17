// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The body's paste of a canvas clipboard (inner#1351 + inner#1390 design
 * §5.1, §5.2): nodes copied on the canvas or a picture copied in the Agent
 * panel land as text and pending media blocks, put at the selection by the
 * body's placement (§5.4.3) in the paste event, so one undo takes the whole
 * paste away; the uploads behind the blocks start once it is in.
 */

import { blockToNode } from '@blocknote/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { Selection } from '@tiptap/pm/state';
import { CellSelection, handlePaste as tablePaste } from '@tiptap/pm/tables';

import { newId } from '@breatic/shared';

import { parseClipboard } from '@web/spaces/canvas/node-clipboard';
import { planCanvasPaste } from '@web/spaces/document/document-canvas-paste';
import { inTableCell, type BlockSpec, type PasteHandler } from '@web/spaces/document/document-file-input';
import { putBlocks, putContent } from '@web/spaces/document/document-put';
import { pendingBlock } from '@web/spaces/document/document-uploads';
import type { UploadSource } from '@web/spaces/document/document-upload-controller';

/** Where a canvas paste hands its uploads and what it could not paste. */
export interface CanvasPasteSink {
  /** Starts the upload behind a pending block just inserted. */
  start: (uploadId: string, source: UploadSource) => void;
  /** Tells the reader how many nodes could not be pasted. */
  notPasted: (count: number) => void;
}

/**
 * Lines of a text node as the selection takes them, the words as they are,
 * never read as markdown. Text in a table cell, or over selected cells,
 * holds no paragraphs, so the lines are joined by line breaks; anywhere else
 * each line is a paragraph in a group, opened at both ends so the first line
 * joins the words before the caret and the last the words after it, as a
 * slice of the body's own lines is: the shape BlockNote's `transformPasted`
 * takes, which gives the first line the type of an empty line it lands on.
 * @param selection - The selection they replace.
 * @param lines - The lines.
 * @returns The slice.
 */
function textSlice(selection: Selection, lines: readonly string[]): Slice {
  const { schema } = selection.$from.doc.type;
  if (selection instanceof CellSelection || inTableCell(selection.$from)) {
    const inline = lines.flatMap((line, index) => [
      ...(index > 0 ? [schema.nodes['hardBreak']!.create()] : []),
      ...(line === '' ? [] : [schema.text(line)]),
    ]);
    return new Slice(Fragment.from(inline), 0, 0);
  }
  const nodes = lines.map((line) =>
    blockToNode({ id: newId(), type: 'paragraph', content: line } as never, schema),
  );
  return new Slice(Fragment.from(schema.nodes['blockGroup']!.create(null, nodes)), 3, 3);
}

/**
 * Wraps the next paste hook with the canvas clipboard's.
 * @param sink - Where uploads start and what could not be pasted is told.
 * @param next - The hook a paste of anything else goes to.
 * @returns The hook.
 */
export function canvasPasteHandler(sink: CanvasPasteSink, next: PasteHandler): PasteHandler {
  return (context) => {
    const payload = parseClipboard(context.event.clipboardData?.getData('text/plain') ?? '');
    if (payload === null) return next(context);
    const { items, notPasted } = planCanvasPaste(payload);
    const { editor } = context;
    const view = editor.prosemirrorView;
    if (view !== undefined && view !== null && items.length > 0) {
      if (items.every((item) => item.kind === 'text')) {
        const lines = items.flatMap((item) => (item.kind === 'text' ? item.lines : []));
        /**
         * Pastes the lines as ProseMirror pastes a slice, its `transformPasted`
         * first; of the paste handlers only the table's, which fills selected
         * cells, takes them (design §5.4.3: no link made of an address).
         */
        const paste = (): void => {
          let slice = textSlice(view.state.selection, lines);
          view.someProp('transformPasted', (transform) => {
            slice = transform(slice, view, true);
          });
          if (!tablePaste(view, context.event, slice)) view.dispatch(view.state.tr.replaceSelection(slice));
        };
        const blocks = lines.map((line) => ({ type: 'paragraph', content: line }));
        putContent(editor, { blocks, lost: 0, plain: lines.join('\n'), paste }, { wordsIntoTarget: true, judge: (props) => props });
      } else {
        const started: { uploadId: string; source: UploadSource }[] = [];
        const blocks = items.flatMap((item): BlockSpec[] => {
          if (item.kind === 'text') return item.lines.map((line) => ({ type: 'paragraph', content: line }));
          const uploadId = newId();
          started.push({ uploadId, source: item.source });
          return [
            pendingBlock(item.type, uploadId, item.name, item.caption, {
              ...(item.mediaWidth !== undefined && { mediaWidth: item.mediaWidth }),
              ...(item.mediaHeight !== undefined && { mediaHeight: item.mediaHeight }),
            }),
          ];
        });
        putBlocks(editor, blocks);
        for (const { uploadId, source } of started) sink.start(uploadId, source);
      }
    }
    if (notPasted > 0) sink.notPasted(notPasted);
    return true;
  };
}
