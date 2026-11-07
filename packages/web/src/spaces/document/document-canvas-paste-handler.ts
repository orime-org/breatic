// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The body's paste of a canvas clipboard (inner#1351 + inner#1390 design
 * §5.1, §5.2): nodes copied on the canvas or a picture copied in the Agent
 * panel land as text and pending media blocks, put at the selection by the
 * body's placement (§5.4.3) in the paste event, so one undo takes the whole
 * paste away; the uploads behind the blocks start once it is in.
 */

import { newId } from '@breatic/shared';

import { parseClipboard } from '@web/spaces/canvas/node-clipboard';
import { planCanvasPaste } from '@web/spaces/document/document-canvas-paste';
import type { BlockSpec, PasteHandler } from '@web/spaces/document/document-file-input';
import { putBlocks, putContent } from '@web/spaces/document/document-put';
import { pendingBlock } from '@web/spaces/document/document-uploads';
import type { UploadSource } from '@web/spaces/document/document-upload-controller';

/** Where a canvas paste hands its uploads and what it could not paste. */
export interface CanvasPasteSink {
  /** Starts the upload behind a pending block just inserted. */
  start: (uploadId: string, source: UploadSource) => void;
  /** Tells the user how many nodes could not be pasted. */
  notPasted: (count: number) => void;
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
        // Built here, the words go in by a dispatch of their own: no paste
        // handler sees them, so no link is made of an address (design §5.4.3).
        const blocks = lines.map((line) => ({ type: 'paragraph', content: line }));
        putContent(editor, { source: { kind: 'blocks', blocks }, lost: 0, plain: lines.join('\n') }, { wordsIntoTarget: true, judge: (props) => props, byPaste: false });
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
