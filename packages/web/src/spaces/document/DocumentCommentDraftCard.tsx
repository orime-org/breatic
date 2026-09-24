// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The card a new comment is written in (#18, A1 · A2 · A21 · A22 · A29 · A30).
 *
 * It sits in the rail among the cards, because a comment is as long as
 * somebody wants it to be and a line floating beside the words holds one
 * line (user 2026-09-23). Everything about where it sits is the rail's, the
 * same rule every other card follows; what is here is the words, the two
 * buttons, and the three ways a draft ends.
 *
 * WHAT IT OWNS is the words, through `reduceDraft` — the same reducer the
 * canvas annotations use (#1881), unchanged. Its `drop` action carries the
 * two closings that are not the reader's doing, and both owe them an
 * account: the text the comment was aimed at is gone (A21), or their right
 * to write here was taken away mid-draft (A22). The notice stands until they
 * dismiss it, which is why this card outlives its range.
 *
 * WHICH WORDS ARE BEING COMMENTED ON is said by the body itself, through
 * `ShowSelectionExtension`: the focus is over here in the rail, and a
 * contenteditable that is not focused has its selection painted by nobody.
 */

import { ShowSelectionExtension } from '@blocknote/core/extensions';
import { TextSelection } from '@tiptap/pm/state';
import { X } from 'lucide-react';
import * as React from 'react';

import type { ProjectRole } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { canPostAnnotations } from '@web/spaces/canvas/annotation/rights';
import {
  CLOSED_DRAFT,
  reduceDraft,
  type DraftState,
} from '@web/stores/annotation-draft';
import { DOCUMENT_COMMENT_DRAFT_RANGE } from '@web/spaces/document/document-comment-draft-range';
import type { DraftRange } from '@web/spaces/document/document-comment-draft-range';
import { DocumentCommentWriteBox } from '@web/spaces/document/DocumentCommentWriteBox';
import { postComment } from '@web/spaces/document/document-comment-post';
import { CARD_SURFACE } from '@web/spaces/document/DocumentCommentCard';
import { useCommentWrite } from '@web/spaces/document/use-comment-write';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';

/** This card's name on the selection extension, which keys its callers. */
const SELECTION_MARK_KEY = 'documentCommentDraftCard';

/** The half of `ShowSelectionExtension` this needs. */
interface ShowSelectionLike {
  /**
   * Draws the body's selection whether or not the body has the focus.
   * @param shouldShow - Whether to draw it.
   * @param key - Which caller is asking.
   */
  showSelection(shouldShow: boolean, key: string): void;
}

interface DraftCardProps {
  /** The editor the comment lands in. */
  editor: ToolEditor;
  /** Where the comment is aimed, or null once that range is gone. */
  aimedAt: DraftRange | null;
  /**
   * The reader's role on the project, watched so losing the right to write
   * closes an open card (A22).
   *
   * Named as `SpaceBodyProps` names it. A prop called `role` on a JSX element
   * is read as the ARIA attribute, by the linter and by anyone reading it.
   */
  myRole: ProjectRole;
  /**
   * Said once this card has nothing left to draw.
   *
   * The rail keeps its place until it hears this, rather than until the range
   * goes: the notice A21 owes the reader is raised by the range going, so a
   * place tied to the range would be gone in the same render.
   */
  onGone?: () => void;
}

/**
 * The card a new comment is written in.
 * @param root0 - The editor, where the comment is aimed, and the role.
 * @param root0.editor - The editor the comment lands in.
 * @param root0.aimedAt - Where the comment is aimed.
 * @param root0.myRole - The reader's role on the project.
 * @param root0.onGone - Said once this card has nothing left to draw.
 * @returns The card while a draft is open or its notice stands.
 */
export function DocumentCommentDraftCard({
  editor,
  aimedAt,
  myRole,
  onGone,
}: DraftCardProps): React.JSX.Element | null {
  const t = useTranslation();
  const [draft, setDraft] = React.useState<DraftState>(CLOSED_DRAFT);
  const mayWrite = canPostAnnotations(myRole);
  const said = useCommentWrite();

  // The words stay visible in the body while this card holds the focus.
  React.useEffect(() => {
    const selection = (
      editor as unknown as {
        getExtension(factory: unknown): ShowSelectionLike | undefined;
      }
    ).getExtension(ShowSelectionExtension);
    selection?.showSelection(aimedAt !== null, SELECTION_MARK_KEY);
    return () => {
      selection?.showSelection(false, SELECTION_MARK_KEY);
    };
  }, [editor, aimedAt]);

  /**
   * Closes the draft's range, which is what takes the card off the rail.
   *
   * The selection is dropped with it (A30). Every way out goes through here,
   * and leaving a selection behind stands the bubble bar back up the moment
   * the card goes — which is not what the reader asked for by saving or by
   * pressing Escape (user 2026-09-22).
   */
  const clearRange = React.useCallback((): void => {
    const view = editor.prosemirrorView;
    if (view === null) return;
    const { selection } = view.state;
    view.dispatch(
      view.state.tr
        .setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, null)
        .setSelection(TextSelection.create(view.state.doc, selection.to)),
    );
  }, [editor]);

  // The range opening is what opens the draft: the entries dispatch it, and
  // this is where that becomes a card with words in it.
  React.useEffect(() => {
    if (aimedAt === null) return;
    setDraft((current) =>
      current.mode === 'closed'
        ? reduceDraft(current, { type: 'open', use: 'annotation', text: '' })
        : current,
    );
  }, [aimedAt]);

  // The two closings that are not the reader's doing. Each drops the draft
  // with its reason, and the reason is what the notice reads from.
  React.useEffect(() => {
    if (aimedAt !== null) return;
    setDraft((current) =>
      current.mode === 'typing'
        ? reduceDraft(current, { type: 'drop', why: 'targetGone' })
        : current,
    );
  }, [aimedAt]);

  React.useEffect(() => {
    if (mayWrite) return;
    setDraft((current) =>
      current.mode === 'typing'
        ? reduceDraft(current, { type: 'drop', why: 'cannotWrite' })
        : current,
    );
    clearRange();
  }, [mayWrite, clearRange]);

  // Nothing aimed at, nothing being written, nothing to say: this card is
  // drawing nothing, and the rail can have its place back.
  const finished =
    aimedAt === null && draft.dropped === undefined && draft.mode !== 'typing';
  React.useEffect(() => {
    if (finished) onGone?.();
  }, [finished, onGone]);

  /** Throws the words away, which Cancel and Escape both do. */
  const cancel = React.useCallback((): void => {
    setDraft((current) => reduceDraft(current, { type: 'escape' }));
    clearRange();
  }, [clearRange]);

  /** Posts what the reader wrote, and closes the card once it has landed. */
  const post = React.useCallback((): void => {
    const saved = reduceDraft(draft, { type: 'save' });
    if (saved.commit === undefined) {
      // Blank words are not worth writing, and the reducer says so by handing
      // back a draft with no `commit` — the card stays open.
      setDraft(saved);
      return;
    }
    void said(postComment(editor, saved.commit)).then((thread) => {
      // No thread means nothing was written, whichever way: `undefined` is a
      // refusal `said` has already reported, `null` is `postComment` finding
      // no range left to aim at. Nothing moves either way — the words are
      // theirs until they send them or throw them away, and the card is where
      // they still are. On the `null` path the notice A21 owes them is raised
      // by the effect watching the range, which needs this card still open.
      if (thread == null) return;
      setDraft(saved);
      // The range is what says a draft is open, so clearing it closes the card.
      clearRange();
    });
  }, [draft, editor, clearRange, said]);

  if (draft.dropped !== undefined) {
    return (
      <article
        data-testid='doc-comment-draft-card'
        className={`${CARD_SURFACE} flex items-start gap-1`}
      >
        <p
          data-testid='doc-comment-draft-dropped'
          className='flex-1 px-1 py-0.5 text-xs text-muted-foreground'
        >
          {t(
            draft.dropped === 'targetGone'
              ? 'spaces.document.comment.targetGone'
              : 'spaces.document.comment.cannotWrite',
          )}
        </p>
        <Button
          variant='ghost'
          size='icon'
          className='size-4.5 shrink-0'
          data-testid='doc-comment-draft-dismiss'
          onClick={() => {
            setDraft(CLOSED_DRAFT);
          }}
        >
          <X className='h-3 w-3' />
        </Button>
      </article>
    );
  }

  if (aimedAt === null || draft.mode !== 'typing') return null;

  return (
    <article
      data-testid='doc-comment-draft-card'
      className={CARD_SURFACE}
    >
      <DocumentCommentWriteBox
        name='draft'
        // eslint-disable-next-line jsx-a11y/no-autofocus -- a card the reader just asked for by pressing the comment entry; they expect to type immediately
        autoFocus
        value={draft.text}
        placeholder={t('spaces.document.comment.placeholder')}
        onChange={(next) => {
          setDraft((current) => reduceDraft(current, { type: 'type', text: next }));
        }}
        onSave={post}
        onCancel={cancel}
        onLeave={() => {
          // A30: an empty draft is the reader having changed their mind, and
          // words they wrote are theirs to keep until they say otherwise.
          if (draft.mode === 'typing' && draft.text.trim().length === 0) {
            cancel();
          }
        }}
      />
    </article>
  );
}
