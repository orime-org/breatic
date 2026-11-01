// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Writing an AI result into the body (inner#1860 A6, design §5.3, the write).
 *
 * Insert puts the parsed result as new blocks under the insert block, through
 * the write path an Agent proposal lands by (`document-proposal-landing.ts`):
 * outside media left out, headings within the body's levels, a table inside a
 * cell unfolded. Replace selects the original range again and pastes the
 * result as Markdown over it (BlockNote's `pasteMarkdown`), so it goes through
 * the paste rules the reader's own paste does. Each is one ordinary edit, an
 * undo step of its own; neither writes without write access.
 */

import { TextSelection } from '@tiptap/pm/state';
import { yUndoPluginKey } from 'y-prosemirror';

import type { DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import { blocksInContext } from '@web/spaces/document/document-proposal-blocks';
import {
  asOneUndoStep,
  blockById,
  prepareWrittenBlocks,
  writeRefusal,
  type ProposalAdmission,
  type UndoBoundary,
} from '@web/spaces/document/document-proposal-landing';
import { blockInTableCell } from '@web/spaces/document/document-table-nodes';

/** How a write ended. */
export type AiWriteResult =
  | { readonly outcome: 'written'; readonly leftOut?: number }
  | { readonly outcome: 'mediaOnly'; readonly leftOut: number }
  | { readonly outcome: 'readOnly' | 'failed' | 'targetGone' };

/** The document parts a write uses: the editor, its undo manager read off its state. */
type AiWritable = Pick<DocumentEditorHandle, 'editor'>;

/**
 * The body's undo manager, as the undo plugin holds it.
 * @param handle - The document.
 * @returns It, or null for a body built without one.
 */
function undoOf(handle: AiWritable): UndoBoundary | null {
  const state = yUndoPluginKey.getState(handle.editor.prosemirrorState) as { undoManager?: UndoBoundary } | undefined;
  return state?.undoManager ?? null;
}

/**
 * Puts a result under the insert block as new blocks.
 * @param handle - The document, mounted.
 * @param blockId - The insert block.
 * @param markdown - The result.
 * @param readAdmission - Reads current lifecycle and write admission synchronously.
 * @returns How it ended, with how many outside media were left out.
 * @throws {Error} If parsing or the block write fails.
 */
export async function insertAiResult(
  handle: AiWritable,
  blockId: string,
  markdown: string,
  readAdmission: () => ProposalAdmission,
): Promise<AiWriteResult> {
  const { blocks, leftOut } = await prepareWrittenBlocks(markdown);
  const refusal = writeRefusal(readAdmission(), handle.editor);
  if (refusal !== null) return { outcome: refusal };
  const doc = handle.editor.prosemirrorState.doc;
  if (blockById(doc, blockId) === null) return { outcome: 'targetGone' };
  const written = blocksInContext(blocks, doc, blockInTableCell(doc, blockId));
  if (written.length === 0) return { outcome: 'mediaOnly', leftOut };
  asOneUndoStep(undoOf(handle), () => {
    handle.editor.insertBlocks(written as never, blockId, 'after');
  });
  return leftOut > 0 ? { outcome: 'written', leftOut } : { outcome: 'written' };
}

/**
 * Swaps the original range for a result.
 * @param handle - The document, mounted.
 * @param range - The original range, where it is now.
 * @param range.from - Its start.
 * @param range.to - Its end.
 * @param markdown - The result.
 * @param readAdmission - Reads current lifecycle and write admission synchronously.
 * @returns How it ended.
 * @throws {Error} If the editor is not mounted or the paste fails.
 */
export async function replaceAiResult(
  handle: AiWritable,
  range: { from: number; to: number },
  markdown: string,
  readAdmission: () => ProposalAdmission,
): Promise<AiWriteResult> {
  const refusal = writeRefusal(readAdmission(), handle.editor);
  if (refusal !== null) return { outcome: refusal };
  const view = handle.editor.prosemirrorView;
  if (view === null) throw new Error('the document editor is not mounted');
  asOneUndoStep(undoOf(handle), () => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)));
    handle.editor.pasteMarkdown(markdown);
  });
  return { outcome: 'written' };
}
