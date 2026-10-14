// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a pending media block shows in place of its media (inner#1351 +
 * inner#1390 design §5.5; demo `2026-10-14-1351-pending-media-block.html`).
 *
 * The whole frame is the block's media frame, so a press selects the block
 * and a drag moves it like any media block; its buttons sit in the media
 * chrome, which the node view hands their events to and the body hides while
 * the editor is not editable. The frame names the file only when the block
 * has no caption: a pasted canvas or Agent item carries its name there, shown
 * under the frame as a media block's caption is.
 */

import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { MediaCaption } from '@web/spaces/document/DocumentMediaBlock';
import type { PendingStatus } from '@web/spaces/document/document-pending-status';

/** Props of {@link DocumentPendingMedia}. */
interface DocumentPendingMediaProps {
  /** The block's name: the file's name for a local file. */
  readonly name: string;
  readonly caption: string;
  readonly status: PendingStatus;
  readonly onRetry: () => void;
  readonly onRemove: () => void;
}

const FRAME = 'flex items-center gap-3 rounded-chrome border px-3.5 py-3 text-sm';

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
  const failed = status.kind === 'failed' || status.kind === 'peerFailed';
  const spinning = status.kind === 'uploading' || status.kind === 'peerUploading';
  const percent =
    status.kind === 'uploading' && status.progress !== null && status.progress < 1
      ? Math.round(status.progress * 100)
      : null;
  const said =
    status.kind === 'failed'
      ? t(status.failure.messageKey, status.failure.params)
      : status.kind === 'peerFailed'
        ? t('spaces.document.media.uploadFailed')
        : status.kind === 'waitingDemoted'
          ? t('spaces.document.media.readOnlyWaiting')
          : status.kind === 'waitingRefused'
            ? t('spaces.document.media.notWrittenYet')
            : status.kind === 'notFinished'
              ? t('spaces.document.media.notFinished')
              : percent === null
                ? t('spaces.document.media.uploading')
                : t('spaces.document.media.uploadingPercent', { percent });
  const retry = status.kind === 'failed' && status.failure.retryable;
  const remove = status.kind === 'failed' || status.kind === 'notFinished';
  const named = caption === '';

  return (
    <div>
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
        {named && (
          <span data-testid='doc-pending-name' className={cn('min-w-0 flex-1 truncate', !failed && 'text-foreground')}>
            {name}
          </span>
        )}
        <span className={cn('min-w-0 truncate', named ? 'shrink' : 'flex-1 text-right')}>{said}</span>
        {percent !== null && (
          <span
            data-testid='doc-pending-progress'
            role='progressbar'
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className='h-1 w-24 shrink-0 overflow-hidden rounded-full bg-muted'
          >
            <span className='block h-full bg-foreground/60' style={{ width: `${percent}%` }} />
          </span>
        )}
        {(retry || remove) && (
        // The body hides `[data-media-chrome]` while it is not editable
        // (`index.css`); a display class on that element would win over it.
          <span data-media-chrome='' className='shrink-0'>
            <span className='flex gap-1.5'>
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
