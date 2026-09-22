// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two entries that open a comment (#18, A1 · A2 · A3, design §6).
 *
 * They differ in one thing: where the range comes from. The bubble bar acts
 * on what the reader selected, the block handle on a range over the hovered
 * row's own content — which the handle's menu computes without dispatching a
 * selection, leaving the reader's caret where it was. From the moment the
 * draft opens the two are one operation, and that is what A2 asks for:
 * commenting on a whole block reads as selecting its text by hand.
 *
 * `canRun` is `canCommentOver`, so an entry over a range with no words in it
 * is unavailable rather than present and inert (A3, R7).
 *
 * THE ROLE DOES NOT COME INTO IT HERE. Both carriers render nothing at all
 * for a viewer — `DocumentEditor.tsx` gates the block strip and the bubble
 * bar on `!readOnly` — so a viewer never reaches either entry. A gate here
 * would be a second answer to a question already answered one layer up.
 */

import { TextSelection } from '@tiptap/pm/state';
import { MessageSquareText } from 'lucide-react';

import { DOCUMENT_COMMENT_DRAFT_RANGE } from '@web/spaces/document/document-comment-draft-range';
import { canCommentOver } from '@web/spaces/document/document-comment-target';
import type { DraftRange } from '@web/spaces/document/document-comment-draft-range';
import type {
  ToolDef,
  ToolEditor,
} from '@web/spaces/document/document-tool-button';

/**
 * Opens a comment draft aimed at one range.
 *
 * The dispatch carries only the meta: no steps, so the document does not
 * change, the reader's selection and caret stay where they are, and nothing
 * lands on the undo stack.
 * @param editor - The document editor.
 * @param range - Where the comment will go.
 * @returns True when a draft opened; false when that range holds no words to
 *   comment on, in which case nothing happened.
 */
export function openCommentDraft(
  editor: ToolEditor,
  range: DraftRange,
): boolean {
  const view = editor.prosemirrorView;
  if (view === null) return false;
  // A selection built to ask the question with, never dispatched — the same
  // thing `selectionOverBlockContent` builds for the commands behind the
  // block handle, and for the same reason: the predicate reads a range, and
  // the reader's own caret is not it.
  const asking = TextSelection.create(view.state.doc, range.from, range.to);
  if (!canCommentOver(view.state.doc, asking)) return false;
  view.dispatch(
    view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, {
      from: range.from,
      to: range.to,
    }),
  );
  return true;
}

/** The bubble bar's comment entry, acting on the reader's selection. */
export const commentTool: ToolDef = {
  id: 'comment',
  labelKey: 'spaces.document.commands.comment',
  Icon: MessageSquareText,

  /**
   * Whether this selection has words a comment could mark.
   * @param editor - The editor.
   * @returns True when there is text under the selection.
   */
  canRun: (editor: ToolEditor): boolean => {
    const view = editor.prosemirrorView;
    if (view === null) return false;
    return canCommentOver(view.state.doc, view.state.selection);
  },

  /**
   * Never pressed.
   *
   * The entry opens a box; it is not a state a selection can be in. Showing
   * it pressed over already-commented words would say pressing it again does
   * something other than start a new comment.
   * @returns False.
   */
  isActive: (): boolean => false,

  /**
   * Opens a draft on the reader's selection.
   * @param editor - The editor.
   */
  run: (editor: ToolEditor): void => {
    const view = editor.prosemirrorView;
    if (view === null) return;
    const { from, to } = view.state.selection;
    openCommentDraft(editor, { from, to });
  },
};
