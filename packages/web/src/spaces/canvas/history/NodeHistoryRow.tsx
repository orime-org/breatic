// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  AlertCircle,
  ArrowUp,
  Film,
  Music,
  Sparkles,
  Star,
} from 'lucide-react';
import * as React from 'react';

import type { NodeHistoryEntry } from '@web/data/api/canvas';
import { useTranslation } from '@web/i18n/use-translation';
import { formatRelativeTime } from '@web/lib/format-relative-time';
import { ThumbnailHoverPreview } from '@web/spaces/canvas/generate/ThumbnailHoverPreview';
import {
  entryCredits,
  entryFilename,
  entryModel,
  isRestorable,
} from '@web/spaces/canvas/history/history-format';

/** The host node's modality — picks the thumbnail treatment. */
export type HistoryModality = 'image' | 'video' | 'audio';

/** Props for {@link NodeHistoryRow}. */
export interface NodeHistoryRowProps {
  /** The history row to render. */
  entry: NodeHistoryEntry;
  /** The host node's modality (image renders the URL; video/audio branch). */
  modality: HistoryModality;
  /** Whether this row is the node's current content (tagged, not restorable). */
  isCurrent: boolean;
  /**
   * Restore an entry onto the node. Takes the entry so the panel can pass ONE
   * stable handler to every row (an inline `() => onRestore(entry)` per row
   * would give each memo'd row a fresh prop identity and defeat the memo).
   */
  onRestore: (entry: NodeHistoryEntry) => void;
}

/**
 * The image `src` to show for a row's thumbnail + hover preview, or null when
 * there is no usable image (a video without a cover, an audio row, a failed
 * row) — those fall back to a modality icon and never feed a `<img>`.
 * @param entry - The history row.
 * @param modality - The host node's modality.
 * @returns The image URL, or null.
 */
function thumbSrc(
  entry: NodeHistoryEntry,
  modality: HistoryModality,
): string | null {
  if (entry.status === 'failed') return null;
  if (modality === 'image') return entry.thumbnailUrl ?? entry.content;
  if (modality === 'video') return entry.thumbnailUrl; // never `content` (a video URL breaks <img>)
  return null; // audio
}

/**
 * One node-history row (#1619): a thumbnail (image / video cover, or a modality
 * icon), the type chip + model + credits (generation) or filename (upload) on
 * the top line, the relative time below, and an action (Restore / Current tag /
 * "can't restore"). Failed rows are greyed and never restorable.
 * @param root0 - Component props.
 * @param root0.entry - The history row.
 * @param root0.modality - The host node's modality.
 * @param root0.isCurrent - Whether this row is the node's current content.
 * @param root0.onRestore - Restore this entry onto the node.
 * @returns The row.
 */
export const NodeHistoryRow = React.memo(function NodeHistoryRow({
  entry,
  modality,
  isCurrent,
  onRestore,
}: NodeHistoryRowProps): React.JSX.Element {
  const t = useTranslation();
  const failed = entry.status === 'failed';
  const src = thumbSrc(entry, modality);
  const model = entryModel(entry);
  const credits = entryCredits(entry);
  const filename = entryFilename(entry);
  const restorable = isRestorable(entry);

  const thumb = (
    <div
      className={
        'flex h-[46px] w-[46px] shrink-0 items-center justify-center overflow-hidden rounded-content-sm border border-border bg-muted' +
        (failed ? ' text-status-error' : ' text-muted-foreground')
      }
    >
      {src ? (
        <img
          src={src}
          alt=''
          className='h-full w-full object-cover'
          loading='lazy'
          decoding='async'
          draggable={false}
        />
      ) : failed ? (
        <AlertCircle className='h-4 w-4' aria-hidden='true' />
      ) : modality === 'video' ? (
        <Film className='h-4 w-4' aria-hidden='true' />
      ) : (
        <Music className='h-4 w-4' aria-hidden='true' />
      )}
    </div>
  );

  return (
    <div
      data-testid='node-history-row'
      className={
        'grid grid-cols-[46px_1fr_auto] items-center gap-2.5 rounded-content-sm px-1.5 py-1.5 transition-colors' +
        (isCurrent ? ' bg-accent' : ' hover:bg-accent') +
        (failed ? ' opacity-60' : '')
      }
    >
      {/* Only image / video-with-cover get a hover preview; audio + failed
          rows have no usable image, so no preview (batch-5 empty-box guard). */}
      {src ? (
        <ThumbnailHoverPreview src={src} alt=''>
          {thumb}
        </ThumbnailHoverPreview>
      ) : (
        thumb
      )}

      <div className='flex min-w-0 flex-col gap-0.5'>
        <div className='flex min-w-0 items-center gap-1.5'>
          {/* The type chip states ONLY what the entry IS (Generated / Upload),
              never its success/failure — that is carried by the other fields
              (the red error message beside it, the "Can't restore" action
              slot). Type is type, independent of outcome (user 2026-07-22). */}
          <span className='inline-flex shrink-0 items-center gap-1 rounded-content-sm border border-border px-1.5 py-px text-2xs font-semibold leading-tight text-muted-foreground'>
            {entry.entryType === 'generation' ? (
              <Sparkles className='h-2.5 w-2.5' aria-hidden='true' />
            ) : (
              <ArrowUp className='h-2.5 w-2.5' aria-hidden='true' />
            )}
            {t(
              entry.entryType === 'generation'
                ? 'canvas.history.typeGeneration'
                : 'canvas.history.typeUpload',
            )}
          </span>
          <span
            className={
              'min-w-0 flex-1 truncate text-xs ' +
              (failed ? 'text-status-error' : 'text-muted-foreground')
            }
          >
            {failed
              ? (entry.errorMessage ?? '')
              : entry.entryType === 'upload'
                ? (filename ?? t('canvas.history.typeUpload'))
                : (model ?? null)}
          </span>
          {!failed &&
          entry.entryType === 'generation' &&
          credits != null ? (
              <span className='inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-foreground'>
                <Star
                  className='h-3 w-3 text-muted-foreground'
                  aria-hidden='true'
                />
                {credits}
              </span>
            ) : null}
        </div>
        {/* Time, then who did it (#1619): the operator's personal-studio
            display name, joined server-side. Shown only when resolved — a
            deleted studio yields null, so the row falls back to time alone. */}
        <div className='flex min-w-0 items-center gap-1 text-2xs text-muted-foreground'>
          <span className='shrink-0 tabular-nums'>
            {formatRelativeTime(entry.createdAt, t)}
          </span>
          {entry.operatorName ? (
            <>
              <span aria-hidden='true'>·</span>
              <span className='truncate'>{entry.operatorName}</span>
            </>
          ) : null}
        </div>
      </div>

      <div className='shrink-0'>
        {isCurrent ? (
          <span className='rounded-content-sm border border-border px-2 py-1 text-2xs font-medium text-muted-foreground'>
            {t('canvas.history.current')}
          </span>
        ) : restorable ? (
          <button
            type='button'
            data-testid='node-history-restore'
            onClick={() => onRestore(entry)}
            className='rounded-content-sm bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
          >
            {t('canvas.history.restore')}
          </button>
        ) : (
          <span className='text-2xs text-status-error'>
            {t('canvas.history.failed')}
          </span>
        )}
      </div>
    </div>
  );
});
