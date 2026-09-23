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
 *
 * WHAT IT OFFERS IS ONLY OFFERED ON THE THREAD BEING READ (user 2026-09-22).
 * The panel is a column of threads to read; a reply box and two buttons on
 * every one of them makes it a column of controls, and only the thread the
 * reader is on is the one they are about. Opening a thread — a press here, a
 * press on its highlight in the body — is what brings them out.
 *
 * A THREAD NOBODY IS READING IS FOLDED, for the same reason: a column where
 * every thread is written out in full cannot be read down at all. It shows
 * its first comment and its most recent one, each cut to three lines, which
 * is the shape CKEditor's sidebar folds an inactive thread into
 * (`maxCommentsWhenCollapsed` 2, `maxCommentCharsWhenCollapsed` trimming each
 * one). Opening it unfolds it; there is no separate control, because the
 * press that would work one is already the press that opens the thread.
 */

import { X } from 'lucide-react';
import * as React from 'react';

import type { ProjectRole } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Textarea } from '@web/components/ui/textarea';
import { useTranslation } from '@web/i18n/use-translation';
import { formatRelativeTime } from '@web/lib/format-relative-time';
import { useAutosizeTextarea } from '@web/lib/use-autosize-textarea';
import { NOTE_MAX_CHARS } from '@web/spaces/canvas/annotation/caps';
import { useNoteBox } from '@web/spaces/canvas/annotation/note-box-keys';
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
 * How much of a comment a folded thread shows.
 *
 * Cut by lines rather than by characters, which is what the browser can do
 * exactly: the ellipsis lands where the text actually wraps, at whatever
 * width the panel happens to be and in whatever script the comment is
 * written. CKEditor cuts the same thing by character count.
 */
const FOLDED_LINE_CLAMP = 'line-clamp-3';

/**
 * How tall the reply box may grow before it scrolls: four lines of it.
 *
 * `text-sm` is 14px over a 20px line, and the box keeps `py-1` the way every
 * other field in this Space does, so four lines is 4 × 20 plus the 8 of the
 * padding. Past that the words scroll rather than push the thread they are
 * answering off the panel (user 2026-09-22).
 */
const REPLY_BOX_MAX_HEIGHT = 'max-h-[88px]';

interface EntryProps {
  /** The comment to draw. */
  entry: CommentEntryView;
  /** Whether this reader may withdraw it. */
  canDelete: boolean;
  /** Whether to cut it short, which a folded thread does. */
  folded: boolean;
  /** Withdraws it. */
  onDelete: () => void;
}

/**
 * One comment or reply.
 * @param root0 - See {@link EntryProps}.
 * @param root0.entry - The comment to draw.
 * @param root0.canDelete - Whether this reader may withdraw it.
 * @param root0.folded - Whether to cut it short.
 * @param root0.onDelete - Withdraws it.
 * @returns The entry.
 */
function Entry({
  entry,
  canDelete,
  folded,
  onDelete,
}: EntryProps): React.JSX.Element {
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
      <div
        className={`mt-0.5 whitespace-pre-wrap break-words text-sm ${
          folded ? FOLDED_LINE_CLAMP : ''
        }`}
      >
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
  selected,
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
  const box = React.useRef<HTMLTextAreaElement>(null);
  useAutosizeTextarea(box, reply);
  const mayWrite = canPostAnnotations(myRole);
  const settled = card.state === 'resolved' || card.state === 'resolvedOrphaned';
  // A thread carries no author of its own, so whoever opened it is the author
  // of its first comment — the same reading the store's auth makes.
  const mayDeleteThread = annotationRights({
    role: myRole,
    viewerId,
    authorId: card.entries[0]?.authorId ?? '',
  }).canDelete;

  // What a folded thread draws: its first comment and its most recent one.
  const folded = !selected && card.entries.length > FOLDED_ENTRY_COUNT;
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

  // Enter saves, Shift+Enter is a line inside the reply, and nothing commits
  // while an input method is composing — the rules a canvas note's boxes take,
  // from the one place all of them take them.
  const keys = useNoteBox(
    React.useCallback(
      (action) => {
        if (action.type === 'save') send();
        else if (action.type === 'escape') callOff();
      },
      [send, callOff],
    ),
  );

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

      {drawn.map((entry, index) => (
        <React.Fragment key={entry.id}>
          <Entry
            entry={entry}
            // The opening comment is the thread: withdrawing it is withdrawing
            // the thread, which is the control below rather than this one.
            canDelete={
              selected &&
              entry.id !== card.entries[0]?.id &&
              annotationRights({
                role: myRole,
                viewerId,
                authorId: entry.authorId,
              }).canDelete
            }
            folded={folded}
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
      {mayWrite && selected && !settled && (
        // The box takes the whole width and the pair sits under it, the shape
        // a canvas note's reply row settles on: side by side, the buttons
        // take the width the words need, and they are worth drawing only once
        // there are words to act on.
        <div className='mt-2 flex flex-col gap-1.5'>
          {/* The border and the focus colour sit on the scroller, which is
              the element that stays still; the box inside it is always
              exactly as tall as what is written, so what scrolls is the
              words. */}
          <ScrollArea
            scrollbars='vertical'
            className='rounded-chrome border border-border bg-background transition-colors focus-within:border-active-border'
            viewportClassName={REPLY_BOX_MAX_HEIGHT}
            data-testid='doc-comment-reply-scroller'
          >
            <Textarea
              ref={box}
              rows={1}
              maxLength={NOTE_MAX_CHARS}
              data-testid='doc-comment-reply-input'
              className='min-h-0 resize-none overflow-hidden rounded-none border-0 bg-transparent px-2 py-1 text-sm focus-visible:border-0 md:text-sm'
              placeholder={t('spaces.document.comment.reply')}
              value={reply}
              onChange={(event) => {
                setReply(event.target.value);
              }}
              {...keys.box}
            />
          </ScrollArea>
          {reply.length > 0 && (
            <div className='flex justify-end gap-1.5'>
              <Button
                variant='outline'
                size='sm'
                data-testid='doc-comment-reply-cancel'
                onClick={() => {
                  if (keys.composing()) return;
                  callOff();
                }}
              >
                {t('spaces.document.comment.cancel')}
              </Button>
              <Button
                size='sm'
                data-testid='doc-comment-reply-save'
                onClick={() => {
                  if (keys.composing()) return;
                  send();
                }}
              >
                {t('spaces.document.comment.save')}
              </Button>
            </div>
          )}
        </div>
      )}

      {mayWrite && selected && (
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
