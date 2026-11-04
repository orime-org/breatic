// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The paste of anything that is not files or a canvas clipboard (inner#1351 +
 * inner#1390 design §5.1, §5.4): read first (`document-paste-read.ts`), then
 * put at the selection (`document-put.ts`), lines of words alone by the
 * paste of their format, as BlockNote pastes them.
 */

import type { PasteHandler } from '@web/spaces/document/document-file-input';
import { PASTED_MEDIA_KEY, type PastedMediaJudge } from '@web/spaces/document/document-external-media';
import { readTransfer } from '@web/spaces/document/document-paste-read';
import { putContent } from '@web/spaces/document/document-put';

/**
 * Reads a paste and puts what it carries at the selection.
 * @param context - What BlockNote hands the paste hook.
 * @param context.event - The paste.
 * @param context.editor - The editor.
 * @param context.defaultPasteHandler - BlockNote's own paste, for a paste event with no clipboard.
 * @returns Whether the paste was handled.
 */
export const documentPasteHandler: PasteHandler = ({ event, editor, defaultPasteHandler }) => {
  const data = event.clipboardData;
  const pasted = editor.getExtension(PASTED_MEDIA_KEY) as PastedMediaJudge | undefined;
  if (data === null || pasted === undefined) return defaultPasteHandler();
  putContent(editor as never, readTransfer(editor as never, data, pasted.lands), {
    wordsIntoTarget: true,
    judge: pasted.judge,
    leaveOut: pasted.leaveOut,
  });
  return true;
};
