// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a pending media block shows in place of its media (inner#1351 +
 * inner#1390 design §5.5; demo `2026-10-14-1351-pending-media-block.html`).
 *
 * The whole frame is the block's media frame, so a press selects the block
 * and a drag moves it like any media block; its buttons sit in the media
 * chrome, which the node view hands their events to and the body hides while
 * the editor is not editable. The frame names the file only when the block
 * has no caption: a pasted canvas or Agent item carries its name there, shown
 * under the frame as a media block's caption is. A failure says the name and
 * its reason as one line; every line is as tall as the buttons, so the frame
 * keeps its height from state to state. The block is held to the width it is
 * given, as a media block in a table cell is, and what does not fit wraps.
 */

import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { MediaCaption } from '@web/spaces/document/DocumentMediaBlock';
import type { PendingStatus } from '@web/spaces/document/document-pending-status';
import type { PendingFailureReason } from '@web/spaces/document/document-upload-controller';

/** Props of {@link DocumentPendingMedia}. */
interface DocumentPendingMediaProps {
  /** The block's name: the file's name for a local file. */
  readonly name: string;
  readonly caption: string;
  readonly status: PendingStatus;
  readonly onRetry: () => void;
  readonly onRemove: () => void;
}

const FRAME =
  'flex flex-wrap items-center gap-x-3 rounded-chrome border px-3.5 py-3 text-sm leading-[var(--btn-compact)] tabular-nums';

/**
 * What each status that is not a failure says when no percent is shown; a
 * status added to `PendingStatus` does not compile until it is placed here or
 * read as a failure.
 */
const STATUS_MESSAGE: Readonly<Record<Exclude<PendingStatus['kind'], 'failed' | 'peerFailed'>, string>> = {
  uploading: 'spaces.document.media.uploading',
  peerUploading: 'spaces.document.media.uploading',
  waitingDemoted: 'spaces.document.media.readOnlyWaiting',
  waitingRefused: 'spaces.document.media.notWrittenYet',
  notFinished: 'spaces.document.media.notFinished',
};

/** What a failed block says for each reason. */
const FAILURE_MESSAGE: Readonly<Record<PendingFailureReason, string>> = {
  failed: 'spaces.document.media.uploadFailed',
  storageFull: 'spaces.document.media.failure.storageFull',
  rateLimited: 'spaces.document.media.failure.rateLimited',
  hashUnavailable: 'spaces.document.media.failure.hashUnavailable',
  unsupportedType: 'spaces.document.media.failure.unsupportedType',
  tooLarge: 'spaces.document.media.failure.tooLarge',
  empty: 'spaces.document.media.failure.empty',
  unreachable: 'spaces.document.media.failure.unreachable',
};

/**
 * A pending media block.
 * @param props - See {@link DocumentPendingMediaProps}.
 * @param props.name - The block's name.
 * @param props.caption - The block's caption.
 * @param props.status - What it shows.
 * @param props.onRetry - Runs a failed upload again.
 * @param props.onRemove - Removes the block.
 * @returns The frame.
 */
export const DocumentPendingMedia = React.memo(function DocumentPendingMedia({
  name,
  caption,
  status,
  onRetry,
  onRemove,
}: DocumentPendingMediaProps): React.JSX.Element {
  const t = useTranslation();
  const spinning = status.kind === 'uploading' || status.kind === 'peerUploading';
  const percent =
    status.kind === 'uploading' && status.progress !== null && status.progress < 1
      ? Math.round(status.progress * 100)
      : null;
  const named = caption === '';
  const failed = status.kind === 'failed' || status.kind === 'peerFailed';
  const said =
    status.kind === 'failed'
      ? t(FAILURE_MESSAGE[status.failure.reason])
      : status.kind === 'peerFailed'
        ? t(FAILURE_MESSAGE.failed)
        : percent === null
          ? t(STATUS_MESSAGE[status.kind])
          : t('spaces.document.media.uploadingPercent', { percent });
  const retry = status.kind === 'failed' && status.failure.retryable;
  const remove = status.kind === 'failed' || status.kind === 'notFinished';

  return (
    // An inline-size container is held to the width it is given, as
    // `[data-media-box]` is in a table cell (`index.css`): a column then keeps
    // its width while the block uploads.
    <div className='@container'>
      <div
        data-testid='doc-pending-media'
        data-media-frame=''
        data-status={status.kind}
        className={cn(
          FRAME,
          failed
            ? 'border-solid border-status-error-border text-status-error-foreground'
            : 'border-dashed border-border text-muted-foreground',
        )}
      >
        {spinning && <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin' aria-hidden />}
        {failed ? (
          // Narrower than a line holds, as in a table cell, the name and the
          // reason each keep a line of their own and the buttons go below.
          <span
            data-testid='doc-pending-failure'
            className='flex min-w-0 flex-1 basis-full flex-col @min-[16rem]:basis-0 @min-[16rem]:flex-row @min-[16rem]:gap-x-1.5'
          >
            {named && (
              <>
                <span className='min-w-0 shrink-[100] truncate'>{name}</span>
                <span className='hidden shrink-0 @min-[16rem]:inline'> · </span>
              </>
            )}
            <span className='min-w-0 truncate'>{said}</span>
          </span>
        ) : (
          <>
            {named && (
              <span data-testid='doc-pending-name' className='min-w-16 flex-1 truncate text-foreground'>
                {name}
              </span>
            )}
            <span className={cn('min-w-0 truncate', named ? 'shrink' : 'flex-1 text-right')}>{said}</span>
          </>
        )}
        {percent !== null && (
          <span
            data-testid='doc-pending-progress'
            role='progressbar'
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className='h-1 w-24 max-w-full shrink-0 overflow-hidden rounded-full bg-muted'
          >
            <span className='block h-full bg-foreground/60' style={{ width: `${percent}%` }} />
          </span>
        )}
        {(retry || remove) && (
        // The body hides `[data-media-chrome]` while it is not editable
        // (`index.css`); a display class on that element would win over it.
          <span data-media-chrome='' className='min-w-0'>
            <span className='flex flex-wrap gap-1.5'>
              {retry && (
                <Button variant='outline' size='compact' className='text-foreground' data-testid='doc-pending-retry' onClick={onRetry}>
                  {t('spaces.document.media.retry')}
                </Button>
              )}
              {remove && (
                <Button variant='outline' size='compact' className='text-foreground' data-testid='doc-pending-remove' onClick={onRemove}>
                  {t('spaces.document.media.remove')}
                </Button>
              )}
            </span>
          </span>
        )}
      </div>
      {caption !== '' && <MediaCaption caption={caption} />}
    </div>
  );
});
