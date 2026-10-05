// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The card a new comment is written in (#18, A1 · A2 · A21 · A22 · A29 · A30).
 *
 * It sits in the rail among the cards, because a comment is as long as
 * somebody wants it to be and a line floating beside the words holds one
 * line (user 2026-09-23). Everything about where it sits is the rail's, the
 * same rule every other card follows; what is here is the words, the two
 * buttons, and the ways a draft ends.
 *
 * IT KEEPS NOTHING OF ITS OWN. The draft is the editor's: where it is aimed
 * and why it was dropped live in the draft range plugin, the words in
 * `document-comment-unsent.ts`, and whether it is the card being read in the
 * selection plugin. The card can be mounted again over the same draft — the
 * document body gives way to a notice and comes back — and what the reader
 * wrote, and any notice they were owed, are still there (design §9.4.1).
 *
 * A dropped draft says why until the reader dismisses it: the text it was
 * aimed at is gone (A21), or their right to write here was taken away (A22).
 *
 * WHICH WORDS ARE BEING COMMENTED ON is said twice: the body paints them in
 * the comment colours through the draft range (design §9.4.1), and the card
 * quotes them in one line at its top, the way a saved card does, read from
 * the body on every change.
 */

import { caretAt } from '@web/spaces/document/document-body-edge-selection';
import { X } from 'lucide-react';
import * as React from 'react';

import type { ProjectRole } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { canPostAnnotations } from '@web/spaces/canvas/annotation/rights';
import {
  DOCUMENT_COMMENT_DRAFT_RANGE,
  draftRangeIn,
  type Draft,
  type DraftCommand,
} from '@web/spaces/document/document-comment-draft-range';
import {
  draftWordsOf,
  onUnsentChange,
  writeDraftWords,
} from '@web/spaces/document/document-comment-unsent';
import { DocumentCommentWriteBox } from '@web/spaces/document/DocumentCommentWriteBox';
import { postComment } from '@web/spaces/document/document-comment-post';
import {
  CARD_READING_OUTLINE,
  CARD_SURFACE,
  CommentQuote,
} from '@web/spaces/document/DocumentCommentCard';
import { useEditorSnapshot } from '@web/spaces/document/use-editor-snapshot';
import { useCommentWrite } from '@web/spaces/document/use-comment-write';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';

interface DraftCardProps {
  /** The editor the comment lands in. */
  editor: ToolEditor;
  /** The draft this card draws. */
  draft: Draft;
  /**
   * The reader's role on the project, watched so losing the right to write
   * drops the draft (A22).
   *
   * Named as `SpaceBodyProps` names it. A prop called `role` on a JSX element
   * is read as the ARIA attribute, by the linter and by anyone reading it.
   */
  myRole: ProjectRole;
  /** Whether this is the card being read. */
  reading: boolean;
}

/**
 * The words the open draft is aimed at, as the body stands.
 *
 * Blocks are joined by a space, the way a saved card joins its stretches.
 * @param editor - The document editor.
 * @returns Those words, or null while no draft is aimed anywhere.
 */
function readDraftQuote(editor: ToolEditor): string | null {
  const state = editor.prosemirrorView?.state;
  if (state === undefined) return null;
  const aim = draftRangeIn(state);
  return aim === null
    ? null
    : aim.segments.map(({ from, to }) => state.doc.textBetween(from, to, ' ')).join(' ');
}

/**
 * The card a new comment is written in.
 * @param root0 - The editor, the draft, the role, and whether it is read.
 * @param root0.editor - The editor the comment lands in.
 * @param root0.draft - The draft this card draws.
 * @param root0.myRole - The reader's role on the project.
 * @param root0.reading - Whether this is the card being read.
 * @returns The card.
 */
export function DocumentCommentDraftCard({
  editor,
  draft,
  myRole,
  reading,
}: DraftCardProps): React.JSX.Element {
  const t = useTranslation();
  const mayWrite = canPostAnnotations(myRole);
  const said = useCommentWrite();
  const { opening } = draft;
  const words = React.useSyncExternalStore(onUnsentChange, () =>
    draftWordsOf(opening),
  );
  // Read from the body on every change: a rewrite inside the range can leave
  // its two ends where they were.
  const quote = useEditorSnapshot(editor, readDraftQuote);

  /**
   * Sends one command to the draft, dropping the selection with it (A30).
   *
   * Every way a draft closes or drops goes through here, and leaving a
   * selection behind stands the bubble bar back up the moment the card goes —
   * which is not what the reader asked for by saving or by pressing Escape
   * (user 2026-09-22).
   * @param command - What to do with the draft.
   */
  const command = React.useCallback(
    (command: DraftCommand): void => {
      const view = editor.prosemirrorView;
      if (view === null) return;
      const { selection } = view.state;
      view.dispatch(
        view.state.tr
          .setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, command)
          .setSelection(caretAt(selection, 1)),
      );
    },
    [editor],
  );

  /** Throws the draft away, which Cancel, Escape and Dismiss all do. */
  const close = React.useCallback((): void => {
    command(null);
  }, [command]);

  // A22: only a draft still aimed somewhere can lose the right to be written.
  React.useEffect(() => {
    if (mayWrite || draft.kind !== 'aimed') return;
    command({ drop: 'cannotWrite' });
  }, [mayWrite, draft.kind, command]);

  // A30: an empty draft ends on a press anywhere outside the card — the body,
  // blank panel space, another card. It is the press, not the focus leaving,
  // that says the reader went elsewhere: a menu handing the focus back to the
  // body as it closes, a press on the card's own padding and a switch to
  // another window all move the focus without the reader leaving. Radix's
  // DismissableLayer answers "outside" the same way (`onPointerDownOutside`).
  // Words the reader wrote are theirs to keep until they say otherwise.
  const card = React.useRef<HTMLElement>(null);
  const empty = draft.kind === 'aimed' && words.trim().length === 0;
  React.useEffect(() => {
    const own = card.current;
    if (!empty || own === null) return;
    const doc = own.ownerDocument;
    /**
     * Closes the draft when the press lands outside the card.
     * @param event - The press.
     */
    const onPress = (event: PointerEvent): void => {
      if (event.target instanceof Node && own.contains(event.target)) return;
      close();
    };
    doc.addEventListener('pointerdown', onPress, true);
    return (): void => {
      doc.removeEventListener('pointerdown', onPress, true);
    };
  }, [empty, close]);

  /** Posts what the reader wrote, and closes the card once it has landed. */
  const post = React.useCallback((): void => {
    // Words that are only spaces are not worth writing; the card stays open.
    if (words.trim().length === 0) return;
    void said(postComment(editor, words)).then((thread) => {
      // No thread means nothing was written, whichever way: `undefined` is a
      // refusal `said` has already reported, `null` is `postComment` finding
      // no range left to aim at — and the draft range plugin has already
      // dropped the draft for that, so the notice A21 owes them is showing.
      // Nothing else moves: the words are theirs until they send them or
      // throw them away.
      if (thread == null) return;
      close();
    });
  }, [words, editor, close, said]);

  if (draft.kind === 'dropped') {
    return (
      <article
        data-testid='doc-comment-draft-card'
        data-selected={reading}
        className={`${CARD_SURFACE} ${CARD_READING_OUTLINE} flex items-start gap-1`}
      >
        <p
          data-testid='doc-comment-draft-dropped'
          className='flex-1 px-1 py-0.5 text-xs text-muted-foreground'
        >
          {t(
            draft.why === 'targetGone'
              ? 'spaces.document.comment.targetGone'
              : 'spaces.document.comment.cannotWrite',
          )}
        </p>
        <Button
          variant='chrome-ghost'
          size='icon'
          className='size-4.5 shrink-0'
          data-testid='doc-comment-draft-dismiss'
          onClick={close}
        >
          <X className='h-3 w-3' />
        </Button>
      </article>
    );
  }

  return (
    <article
      ref={card}
      data-testid='doc-comment-draft-card'
      data-selected={reading}
      className={`${CARD_SURFACE} ${CARD_READING_OUTLINE}`}
    >
      {quote !== null && (
        <CommentQuote words={quote} testId='doc-comment-draft-quote' />
      )}
      <DocumentCommentWriteBox
        // Mounted afresh on every press of an entry, the first one or one
        // that only moves the draft: each is the reader asking to write.
        key={draft.entry}
        name='draft'
        // The focus goes to a draft the reader just asked for, which is the
        // card being read the moment it opens. The card mounting again while
        // another card is being read leaves that one alone.
        // eslint-disable-next-line jsx-a11y/no-autofocus -- a card the reader just asked for by pressing the comment entry; they expect to type immediately
        autoFocus={reading}
        value={words}
        placeholder={t('spaces.document.comment.placeholder')}
        onChange={(next) => {
          writeDraftWords(opening, next);
        }}
        onSave={post}
        onCancel={close}
      />
    </article>
  );
}
