// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One comment thread, as the panel draws it (#18, A4 · A7 – A13 · A17).
 *
 * The quote comes first, then the opening comment and every reply below it,
 * then what this reader may do about it. A thread whose words were deleted
 * has no card (A13).
 *
 * WHAT IS OFFERED IS `annotationRights`, delivered with canvas annotations
 * (#1881), so a comment and a canvas note answer the same question the same
 * way: the author may withdraw their own, an owner may remove anybody's, and
 * nobody may rewrite what somebody else said. Resolving is not the author's
 * privilege — settling a discussion belongs to whoever may write.
 *
 * The thread store asks its own auth before every write, so a control drawn
 * by mistake would fail rather than damage anything. Drawing the right ones
 * is what keeps a reader from being offered something that cannot happen.
 *
 * The quote does not say whether the comment was made on a selection or on a
 * whole block. Design §6.1 settles that the two entries are the same
 * operation past the range, so there is no kind to draw.
 *
 * WHAT IT OFFERS IS ONLY OFFERED ON THE THREAD BEING READ (user 2026-09-22).
 * The panel is a column of threads to read; a reply box and two buttons on
 * every one of them makes it a column of controls, and only the thread the
 * reader is on is the one they are about. Opening a thread — a press here, a
 * press on its highlight in the body — is what brings them out.
 *
 * A THREAD NOBODY IS READING IS FOLDED, for the same reason: a column where
 * every thread is written out in full cannot be read down at all. Every
 * comment on it is cut to three lines, and once it holds more than two only
 * its first and its most recent are drawn — the shape CKEditor's sidebar
 * folds an inactive thread into (`maxCommentCharsWhenCollapsed` trimming each
 * one, `maxCommentsWhenCollapsed` 2 holding the rest back). Opening it
 * unfolds it; there is no separate control, because the press that would
 * work one is already the press that opens the thread.
 */

import { X } from 'lucide-react';
import * as React from 'react';

import type { ProjectRole } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { formatRelativeTime } from '@web/lib/format-relative-time';
import { DocumentCommentWriteBox } from '@web/spaces/document/DocumentCommentWriteBox';
import {
  annotationRights,
  canPostAnnotations,
} from '@web/spaces/canvas/annotation/rights';
import { openedBy } from '@web/spaces/document/document-comment-auth';
import { StudioAvatar } from '@web/ui/StudioAvatar';
import type {
  CommentCardView,
  CommentEntryView,
} from '@web/spaces/document/use-comment-cards';

/**
 * The box every card in the rail is drawn on.
 *
 * Shared with the draft card: one comment being written and one already
 * written are the same object to a reader, and a surface described twice
 * drifts.
 */
export const CARD_SURFACE =
  'rounded-content-sm border border-border bg-card p-2.5';

/** The outline a card wears while it is the one being read, on `data-selected`. */
export const CARD_READING_OUTLINE = 'data-[selected=true]:border-active-border';

/**
 * The words a card is about, one line at the top of it.
 *
 * Shared with the draft card for the reason the surface is: a comment being
 * written and one already written say which words they are about the same way.
 * @param root0 - The words and the test hook.
 * @param root0.words - The words the comment is about.
 * @param root0.testId - Test hook for the line.
 * @returns The line.
 */
export function CommentQuote({
  words,
  testId,
}: {
  words: string;
  testId: string;
}): React.JSX.Element {
  return (
    <p
      data-testid={testId}
      className='mb-2 truncate border-l border-note-border pl-1.5 text-2xs text-muted-foreground'
    >
      {words}
    </p>
  );
}

interface DocumentCommentCardProps {
  /** The thread this card is for. */
  card: CommentCardView;
  /**
   * Whether that press in the body landed on this thread.
   *
   * A press where two comments overlap lands on both (A20), so this says
   * "you hit this one" and nothing more — the card draws its border with it.
   */
  marked: boolean;
  /**
   * Whether this is the thread the reader is reading.
   *
   * One at a time, even where a press marked two: two reply boxes open at
   * once and neither is the one they meant. Everything a reader can do to a
   * thread is offered here and nowhere else.
   */
  reading: boolean;
  /** This reader's role on the project. */
  myRole: ProjectRole;
  /** This reader's account id, absent until the session resolves. */
  viewerId: string | undefined;
  /**
   * What the reader has written into this thread's reply box and not sent.
   *
   * Held by the panel rather than by this card: a thread settled by a peer
   * takes its card out of the open filter, and a reply living in the card's
   * own state would go with it — words the reader typed and never agreed to
   * throw away.
   */
  draft: string;
  /** Remembers what has been written into the reply box. */
  onDraft: (threadId: string, body: string) => void;
  /** Adds a reply. Returns false when the words were blank. */
  onReply: (threadId: string, body: string) => Promise<boolean>;
  /** Marks the thread settled. */
  onResolve: (threadId: string) => void;
  /** Brings a settled thread back. */
  onReopen: (threadId: string) => void;
  /** Withdraws the whole thread. */
  onDelete: (threadId: string) => void;
  /** Withdraws one reply. */
  onDeleteReply: (threadId: string, commentId: string) => void;
}

/**
 * How many comments a folded thread shows: its first and its most recent.
 *
 * CKEditor's `maxCommentsWhenCollapsed` default, and the two that carry the
 * thread: what it is about, and where it has got to.
 */
const FOLDED_ENTRY_COUNT = 2;

/**
 * How much of a comment a card nobody is reading shows.
 *
 * Cut by lines rather than by characters, which is what the browser can do
 * exactly: the ellipsis lands where the text actually wraps, at whatever
 * width the panel happens to be and in whatever script the comment is
 * written. CKEditor cuts the same thing by character count.
 */
const FOLDED_LINE_CLAMP = 'line-clamp-3';

interface EntryProps {
  /** The comment to draw. */
  entry: CommentEntryView;
  /** Whether this reader may withdraw it. */
  canDelete: boolean;
  /** Whether to cut it to three lines, which every unread card does. */
  shortened: boolean;
  /** Withdraws it. */
  onDelete: () => void;
}

/**
 * One comment or reply.
 * @param root0 - See {@link EntryProps}.
 * @param root0.entry - The comment to draw.
 * @param root0.canDelete - Whether this reader may withdraw it.
 * @param root0.shortened - Whether to cut it to three lines.
 * @param root0.onDelete - Withdraws it.
 * @returns The entry.
 */
function Entry({
  entry,
  canDelete,
  shortened,
  onDelete,
}: EntryProps): React.JSX.Element {
  const t = useTranslation();
  const author = entry.author ?? t('spaces.document.comment.unknownAuthor');
  return (
    <div className='mb-2 flex gap-2 last:mb-0' data-testid='doc-comment-entry'>
      <StudioAvatar
        name={author}
        type='personal'
        avatarUrl={entry.avatarUrl}
        size='sm'
        data-testid='doc-comment-avatar'
      />
      <div className='min-w-0 flex-1'>
        <div className='flex items-center text-2xs'>
          <span className='font-medium'>{author}</span>
          <time
            className='ml-1.5 text-muted-foreground'
            dateTime={entry.createdAt.toISOString()}
          >
            {formatRelativeTime(entry.createdAt.getTime(), t)}
          </time>
          {canDelete && (
            <Button
              variant='chrome-ghost'
              size='icon'
              className='ml-auto size-4.5 hover:text-status-error-foreground'
              aria-label={t('spaces.document.comment.deleteReply')}
              data-testid='doc-comment-delete-reply'
              onClick={onDelete}
            >
              <X className='h-3 w-3' />
            </Button>
          )}
        </div>
        <div
          className={`mt-0.5 whitespace-pre-wrap break-words text-sm ${
          shortened ? FOLDED_LINE_CLAMP : ''
        }`}
        >
          {entry.body}
        </div>
      </div>
    </div>
  );
}

/**
 * One thread's card.
 * @param root0 - See {@link DocumentCommentCardProps}.
 * @param root0.card - The thread to draw.
 * @param root0.marked - Whether the press in the body landed on this thread.
 * @param root0.reading - Whether this is the thread being read.
 * @param root0.myRole - This reader's role.
 * @param root0.viewerId - This reader's account id.
 * @param root0.draft - What has been written into the reply box and not sent.
 * @param root0.onDraft - Remembers what has been written there.
 * @param root0.onReply - Adds a reply.
 * @param root0.onResolve - Marks it settled.
 * @param root0.onReopen - Brings it back.
 * @param root0.onDelete - Withdraws the thread.
 * @param root0.onDeleteReply - Withdraws one reply.
 * @returns The card.
 */
export const DocumentCommentCard = React.memo(function DocumentCommentCard({
  card,
  marked,
  reading,
  myRole,
  viewerId,
  draft,
  onDraft,
  onReply,
  onResolve,
  onReopen,
  onDelete,
  onDeleteReply,
}: DocumentCommentCardProps): React.JSX.Element {
  const t = useTranslation();
  const reply = draft;
  const setReply = React.useCallback(
    (body: string) => {
      onDraft(card.id, body);
    },
    [card.id, onDraft],
  );
  const mayWrite = canPostAnnotations(myRole);
  const settled = card.settled;
  const mayDeleteThread = annotationRights({
    role: myRole,
    viewerId,
    authorId: openedBy(card.entries.map((entry) => ({ userId: entry.authorId }))),
  }).canDelete;

  // Two questions, and only one of them counts comments. Every comment on a
  // thread nobody is reading is cut to three lines, however few there are —
  // one comment at the 300-character cap is about nine lines in this column.
  // Holding comments back needs more than two of them to hold back.
  const shortened = !reading;
  const folded = shortened && card.entries.length > FOLDED_ENTRY_COUNT;
  const drawn = folded
    ? [card.entries[0]!, card.entries[card.entries.length - 1]!]
    : card.entries;

  const send = React.useCallback(() => {
    void onReply(card.id, reply).then((sent) => {
      if (sent) setReply('');
    });
  }, [card.id, onReply, reply, setReply]);

  /** Throws away what was written, which is what Cancel and Escape do. */
  const callOff = React.useCallback(() => {
    setReply('');
  }, [setReply]);

  return (
    <article
      data-testid='doc-comment-card'
      data-thread={card.id}
      data-settled={settled}
      data-selected={marked}
      className={`${CARD_SURFACE} ${CARD_READING_OUTLINE} data-[settled=true]:text-muted-foreground`}
    >
      <CommentQuote words={card.quote} testId='doc-comment-card-quote' />

      {drawn.map((entry, index) => (
        <React.Fragment key={entry.id}>
          <Entry
            entry={entry}
            // The opening comment is the thread: withdrawing it is withdrawing
            // the thread, which is the control below rather than this one.
            canDelete={
              reading &&
              entry.id !== card.entries[0]?.id &&
              annotationRights({
                role: myRole,
                viewerId,
                authorId: entry.authorId,
              }).canDelete
            }
            shortened={shortened}
            onDelete={() => {
              onDeleteReply(card.id, entry.id);
            }}
          />
          {/* Between the first comment and the most recent one, which is
              where what is being held back sits. */}
          {folded && index === 0 && (
            <p
              data-testid='doc-comment-folded-count'
              className='mb-2 text-2xs text-muted-foreground'
            >
              {t('spaces.document.comment.folded', {
                count: card.entries.length - drawn.length,
              })}
            </p>
          )}
        </React.Fragment>
      ))}

      {/* A settled thread takes no replies: the discussion is over until
          somebody reopens it. */}
      {mayWrite && reading && !settled && (
        <DocumentCommentWriteBox
          name='reply'
          className='mt-2'
          value={reply}
          placeholder={t('spaces.document.comment.reply')}
          onChange={setReply}
          onSave={send}
          onCancel={callOff}
        />
      )}

      {mayWrite && reading && (
        <div className='mt-2.5 flex gap-1.5 border-t border-border pt-2'>
          {settled ? (
            <Button
              variant='outline'
              size='sm'
              data-testid='doc-comment-reopen'
              onClick={() => {
                onReopen(card.id);
              }}
            >
              {t('spaces.document.comment.reopen')}
            </Button>
          ) : (
            <Button
              variant='outline'
              size='sm'
              data-testid='doc-comment-resolve'
              onClick={() => {
                onResolve(card.id);
              }}
            >
              {t('spaces.document.comment.resolve')}
            </Button>
          )}
          {mayDeleteThread && (
            <Button
              variant='outline'
              size='sm'
              className='ml-auto hover:text-status-error-foreground'
              data-testid='doc-comment-delete'
              onClick={() => {
                onDelete(card.id);
              }}
            >
              {t('spaces.document.comment.deleteThread')}
            </Button>
          )}
        </div>
      )}
    </article>
  );
});
