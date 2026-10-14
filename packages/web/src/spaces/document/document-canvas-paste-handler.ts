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
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';

import { parseClipboard } from '@web/spaces/canvas/node-clipboard';
import { planCanvasPaste, type PastedMedia } from '@web/spaces/document/document-canvas-paste';
import { pasteTarget, type PasteHandler } from '@web/spaces/document/document-file-input';
import { QUOTED } from '@web/spaces/document/document-list-block';
import type { UploadSource } from '@web/spaces/document/document-upload-controller';

/** Where a canvas paste hands its uploads and what it could not paste. */
export interface CanvasPasteSink {
  /** Starts the upload behind a pending block just inserted. */
  start: (uploadId: string, source: UploadSource) => void;
  /** Tells the reader how many nodes could not be pasted. */
  notPasted: (count: number) => void;
  /** Closes the undo step around the paste, so it is a step of its own. */
  stopCapturing?: () => void;
}

/**
 * Where a pasted medium's bytes come from, as the controller takes them.
 * @param media - The medium.
 * @returns The source.
 */
function sourceOf(media: PastedMedia): UploadSource {
  return media.source.kind === 'ours'
    ? { kind: 'ours', url: media.source.url, ...(media.source.coverUrl !== undefined && { coverUrl: media.source.coverUrl }) }
    : { kind: 'address', url: media.source.url };
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
        // One paragraph per line, opened at both ends so the first line joins
        // the words before the caret and the last the words after it, as a
        // plain text paste does; the words go in as they are, never read as
        // markdown.
        const lines = items.flatMap((item) => (item.kind === 'text' ? item.lines : []));
        const nodes = lines.map((line) =>
          blockToNode({ id: crypto.randomUUID(), type: 'paragraph', content: line } as never, view.state.schema),
        );
        sink.stopCapturing?.();
        view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 2, 2)));
        sink.stopCapturing?.();
      } else {
        const { gap, aimed } = pasteTarget(view.state);
        const $gap = view.state.doc.resolve(gap);
        // Quoted as the line it was aimed at, else as the block before it.
        const beside: PMNode | null = aimed ? $gap.nodeAfter : ($gap.nodeBefore ?? $gap.nodeAfter);
        const quoted = beside?.firstChild?.attrs[QUOTED] === true;
        const started: { uploadId: string; source: UploadSource }[] = [];
        const nodes = items.flatMap((item) => {
          if (item.kind === 'text') {
            return item.lines.map((line) =>
              blockToNode(
                { id: crypto.randomUUID(), type: 'paragraph', props: { [QUOTED]: quoted }, content: line } as never,
                view.state.schema,
              ),
            );
          }
          const uploadId = crypto.randomUUID();
          started.push({ uploadId, source: sourceOf(item) });
          return [
            blockToNode(
              {
                id: crypto.randomUUID(),
                type: item.type,
                props: { url: '', uploadId, name: item.name, caption: item.caption, [QUOTED]: quoted },
              } as never,
              view.state.schema,
            ),
          ];
        });
        sink.stopCapturing?.();
        view.dispatch(view.state.tr.insert(gap, Fragment.from(nodes)));
        sink.stopCapturing?.();
        for (const { uploadId, source } of started) sink.start(uploadId, source);
      }
    }
    if (notPasted > 0) sink.notPasted(notPasted);
    return true;
  };
}
