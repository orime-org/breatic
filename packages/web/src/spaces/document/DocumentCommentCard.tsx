// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One comment thread, as the panel draws it (#18, A4 · A7 – A13 · A17).
 *
 * The quote comes first, then the opening comment and every reply below it,
 * then what this reader may do about it. A card whose words were deleted says
 * so in the quote's place — the thread stays readable, and stays answerable,
 * which is the whole of A13.
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
 */

import { X } from 'lucide-react';
import * as React from 'react';

import type { ProjectRole } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { formatRelativeTime } from '@web/lib/format-relative-time';
import {
  annotationRights,
  canPostAnnotations,
} from '@web/spaces/canvas/annotation/rights';
import type {
  CommentCardView,
  CommentEntryView,
} from '@web/spaces/document/use-comment-cards';

interface DocumentCommentCardProps {
  /** The thread this card is for. */
  card: CommentCardView;
  /** Whether this is a thread the reader pressed in the body. */
  selected: boolean;
  /** This reader's role on the project. */
  myRole: ProjectRole;
  /** This reader's account id, absent until the session resolves. */
  viewerId: string | undefined;
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

interface EntryProps {
  /** The comment to draw. */
  entry: CommentEntryView;
  /** Whether this reader may withdraw it. */
  canDelete: boolean;
  /** Withdraws it. */
  onDelete: () => void;
}

/**
 * One comment or reply.
 * @param root0 - See {@link EntryProps}.
 * @param root0.entry - The comment to draw.
 * @param root0.canDelete - Whether this reader may withdraw it.
 * @param root0.onDelete - Withdraws it.
 * @returns The entry.
 */
function Entry({ entry, canDelete, onDelete }: EntryProps): React.JSX.Element {
  const t = useTranslation();
  const author = entry.author ?? t('spaces.document.comment.unknownAuthor');
  return (
    <div className='mb-2 last:mb-0' data-testid='doc-comment-entry'>
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
            variant='ghost'
            size='icon'
            className='ml-auto size-4.5'
            aria-label={t('spaces.document.comment.deleteReply')}
            data-testid='doc-comment-delete-reply'
            onClick={onDelete}
          >
            <X className='h-3 w-3' />
          </Button>
        )}
      </div>
      <div className='mt-0.5 whitespace-pre-wrap break-words text-sm'>
        {entry.body}
      </div>
    </div>
  );
}

/**
 * One thread's card.
 * @param root0 - See {@link DocumentCommentCardProps}.
 * @param root0.card - The thread to draw.
 * @param root0.selected - Whether the reader pressed this thread's highlight.
 * @param root0.myRole - This reader's role.
 * @param root0.viewerId - This reader's account id.
 * @param root0.onReply - Adds a reply.
 * @param root0.onResolve - Marks it settled.
 * @param root0.onReopen - Brings it back.
 * @param root0.onDelete - Withdraws the thread.
 * @param root0.onDeleteReply - Withdraws one reply.
 * @returns The card.
 */
export const DocumentCommentCard = React.memo(function DocumentCommentCard({
  card,
  selected,
  myRole,
  viewerId,
  onReply,
  onResolve,
  onReopen,
  onDelete,
  onDeleteReply,
}: DocumentCommentCardProps): React.JSX.Element {
  const t = useTranslation();
  const [reply, setReply] = React.useState('');
  const mayWrite = canPostAnnotations(myRole);
  const settled = card.state === 'resolved' || card.state === 'resolvedOrphaned';
  // A thread carries no author of its own, so whoever opened it is the author
  // of its first comment — the same reading the store's auth makes.
  const mayDeleteThread = annotationRights({
    role: myRole,
    viewerId,
    authorId: card.entries[0]?.authorId ?? '',
  }).canDelete;

  const send = React.useCallback(() => {
    void onReply(card.id, reply).then((sent) => {
      if (sent) setReply('');
    });
  }, [card.id, onReply, reply]);

  return (
    <article
      data-testid='doc-comment-card'
      data-thread={card.id}
      data-state={card.state}
      data-selected={selected}
      className='rounded-content-sm border border-border bg-card p-2.5 data-[selected=true]:border-active-border data-[state=resolved]:opacity-70 data-[state=resolvedOrphaned]:opacity-70'
    >
      {card.quote === null ? (
        <p
          data-testid='doc-comment-card-orphaned'
          className='mb-2 text-2xs text-muted-foreground'
        >
          {t('spaces.document.comment.orphaned')}
        </p>
      ) : (
        <p
          data-testid='doc-comment-card-quote'
          className='mb-2 truncate border-l border-note-border pl-1.5 text-2xs text-muted-foreground'
        >
          {card.quote}
        </p>
      )}

      {card.entries.map((entry, index) => (
        <Entry
          key={entry.id}
          entry={entry}
          // The opening comment is the thread: withdrawing it is withdrawing
          // the thread, which is the control below rather than this one.
          canDelete={
            index > 0 &&
            annotationRights({
              role: myRole,
              viewerId,
              authorId: entry.authorId,
            }).canDelete
          }
          onDelete={() => {
            onDeleteReply(card.id, entry.id);
          }}
        />
      ))}

      {/* A settled thread takes no replies: the discussion is over until
          somebody reopens it. */}
      {mayWrite && !settled && (
        <div className='mt-2 flex gap-1.5'>
          <input
            data-testid='doc-comment-reply-input'
            className='min-w-0 flex-1 rounded-chrome border border-border bg-background px-2 py-1 text-sm focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring'
            placeholder={t('spaces.document.comment.reply')}
            value={reply}
            onChange={(event) => {
              setReply(event.target.value);
            }}
          />
          <Button
            variant='outline'
            size='sm'
            data-testid='doc-comment-reply-send'
            onClick={send}
          >
            {t('spaces.document.comment.send')}
          </Button>
        </div>
      )}

      {mayWrite && (
        <div className='mt-2.5 flex gap-1.5 border-t border-border pt-2'>
          {settled ? (
            <Button
              variant='outline'
              size='sm'
              className='ml-auto'
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
