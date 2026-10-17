// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The paste of anything that is not files or a canvas clipboard (inner#1351 +
 * inner#1390 design §5.1, §5.4): read first (`document-paste-read.ts`), then
 * put at the selection (`document-put.ts`). Words alone are BlockNote's own
 * paste, as on main.
 */

import type { PasteHandler } from '@web/spaces/document/document-file-input';
import { PASTED_MEDIA_KEY, type PastedMedia } from '@web/spaces/document/document-external-media';
import { readTransfer } from '@web/spaces/document/document-paste-read';
import { putContent } from '@web/spaces/document/document-put';

/**
 * Reads a paste and puts what it carries: content holding a medium or a
 * table, or whose media were left out, by the body's placement; words alone
 * by BlockNote's own paste.
 * @param context - What BlockNote hands the paste hook.
 * @param context.event - The paste.
 * @param context.editor - The editor.
 * @param context.defaultPasteHandler - BlockNote's own paste.
 * @returns Whether the paste was handled.
 */
export const documentPasteHandler: PasteHandler = ({ event, editor, defaultPasteHandler }) => {
  const data = event.clipboardData;
  const pasted = editor.getExtension(PASTED_MEDIA_KEY) as PastedMedia | undefined;
  if (data === null || pasted === undefined || editor.prosemirrorView === undefined || editor.prosemirrorView === null) {
    return defaultPasteHandler();
  }
  const read = readTransfer(editor as never, data, pasted.lands);
  if (read.kind === 'words') return defaultPasteHandler();
  pasted.leaveOut(read.lost);
  if (read.kind === 'blocks') putContent(editor as never, read.blocks, { caller: 'putIn', judge: pasted.judge, plain: read.plain });
  return true;
};
