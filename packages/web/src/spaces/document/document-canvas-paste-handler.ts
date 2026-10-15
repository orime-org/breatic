// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The body's paste of a canvas clipboard (inner#1351 + inner#1390 design
 * §5.1, §5.2): nodes copied on the canvas or a picture copied in the Agent
 * panel land as text and pending media blocks, in one transaction, so one
 * undo takes the whole paste away; the uploads behind the blocks start once
 * it is in.
 */

import { blockToNode } from '@blocknote/core';
import { Fragment, Slice, type ResolvedPos } from '@tiptap/pm/model';

import { newId } from '@breatic/shared';

import { parseClipboard } from '@web/spaces/canvas/node-clipboard';
import { planCanvasPaste } from '@web/spaces/document/document-canvas-paste';
import {
  inTableCell,
  insertAtGapTr,
  pasteTarget,
  type BlockSpec,
  type PasteHandler,
} from '@web/spaces/document/document-file-input';
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
 * Lines of a text node as the place they land takes them, the words as they
 * are, never read as markdown. A paragraph takes one paragraph per line,
 * opened at both ends so the first line joins the words before the caret and
 * the last the words after it, as a plain text paste does; a table cell holds
 * no paragraphs, so its lines are joined by line breaks; a code block holds
 * only text, so they are joined by newlines.
 * @param $at - Where they land.
 * @param lines - The lines.
 * @returns The slice.
 */
function textSlice($at: ResolvedPos, lines: readonly string[]): Slice {
  const { schema } = $at.doc.type;
  if ($at.parent.type.spec.code === true) return new Slice(Fragment.from(schema.text(lines.join('\n'))), 0, 0);
  if (inTableCell($at)) {
    const inline = lines.flatMap((line, index) => [
      ...(index > 0 ? [schema.nodes['hardBreak']!.create()] : []),
      ...(line === '' ? [] : [schema.text(line)]),
    ]);
    return new Slice(Fragment.from(inline), 0, 0);
  }
  const nodes = lines.map((line) =>
    blockToNode({ id: newId(), type: 'paragraph', content: line } as never, schema),
  );
  return new Slice(Fragment.from(nodes), 2, 2);
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
        view.dispatch(view.state.tr.replaceSelection(textSlice(view.state.selection.$from, lines)));
      } else {
        const { gap, aimed } = pasteTarget(view.state);
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
        view.dispatch(insertAtGapTr(view.state, gap, aimed, blocks));
        for (const { uploadId, source } of started) sink.start(uploadId, source);
      }
    }
    if (notPasted > 0) sink.notPasted(notPasted);
    return true;
  };
}
