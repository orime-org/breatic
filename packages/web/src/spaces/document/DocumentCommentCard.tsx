// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One comment thread, as the panel draws it (#18, A4 · A13).
 *
 * The quote comes first, then the opening comment and every reply below it.
 * A card whose words were deleted says so in the quote's place — the thread
 * stays readable, which is the whole of A13.
 *
 * The quote does not say whether the comment was made on a selection or on a
 * whole block. Design §6.1 settles that the two entries are the same
 * operation past the range, so there is no kind to draw.
 */

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { formatRelativeTime } from '@web/lib/format-relative-time';
import type {
  CommentCardView,
  CommentEntryView,
} from '@web/spaces/document/use-comment-cards';

interface DocumentCommentCardProps {
  /** The thread this card is for. */
  card: CommentCardView;
}

/**
 * One comment or reply.
 * @param root0 - Entry props.
 * @param root0.entry - The comment to draw.
 * @returns The entry.
 */
function Entry({ entry }: { entry: CommentEntryView }): React.JSX.Element {
  const t = useTranslation();
  const author = entry.author ?? t('spaces.document.comment.unknownAuthor');
  return (
    <div className='mb-2 last:mb-0' data-testid='doc-comment-entry'>
      <div className='text-2xs'>
        <span className='font-medium'>{author}</span>
        <time
          className='ml-1.5 text-muted-foreground'
          dateTime={entry.createdAt.toISOString()}
        >
          {formatRelativeTime(entry.createdAt.getTime(), t)}
        </time>
      </div>
      <div className='mt-0.5 whitespace-pre-wrap break-words text-sm'>
        {entry.body}
      </div>
    </div>
  );
}

/**
 * One thread's card.
 * @param root0 - Card props.
 * @param root0.card - The thread to draw.
 * @returns The card.
 */
export const DocumentCommentCard = React.memo(function DocumentCommentCard({
  card,
}: DocumentCommentCardProps): React.JSX.Element {
  const t = useTranslation();
  const orphaned = card.quote === null;
  return (
    <article
      data-testid='doc-comment-card'
      data-thread={card.id}
      data-state={card.state}
      className='rounded-content-sm border border-border bg-card p-2.5 data-[state=resolved]:opacity-70 data-[state=resolvedOrphaned]:opacity-70'
    >
      {orphaned ? (
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
      {card.entries.map((entry) => (
        <Entry key={entry.id} entry={entry} />
      ))}
    </article>
  );
});
