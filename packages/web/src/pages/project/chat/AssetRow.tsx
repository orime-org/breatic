// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { AudioLines, Play } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';

import type { ChatAsset } from '@web/pages/project/chat/types';

/**
 * How many squares the row draws before the rest go behind the button.
 *
 * The row is one line, and it neither wraps nor scrolls: a set of results
 * that reflows as the column is dragged is a set the reader cannot point at
 * twice. What it cannot show is one press away.
 */
const SQUARES_IN_THE_ROW = 4;

interface AssetRowProps {
  /** What this turn found. */
  assets: ChatAsset[];
}

/**
 * What a turn found, as one row of squares.
 *
 * Squares whatever shape the thing inside is. A row that let each thumbnail
 * keep its own proportions reads as a pile rather than as a set, and what the
 * reader is doing here is scanning several at once.
 * @param root0 - The component props.
 * @param root0.assets - What this turn found.
 * @returns The row, and the box when one is open.
 */
export const AssetRow = React.memo(function AssetRow({
  assets,
}: AssetRowProps): React.JSX.Element {
  const t = useTranslation();
  const [openAt, setOpenAt] = React.useState<number | null>(null);
  const close = React.useCallback(() => setOpenAt(null), []);

  const shown = assets.slice(0, SQUARES_IN_THE_ROW);
  const hidden = assets.length - shown.length;

  return (
    <>
      <div data-testid='asset-row' className='mt-[0.85em] flex gap-2 overflow-hidden'>
        {shown.map((asset, i) => (
          <AssetThumb key={asset.url} asset={asset} onOpen={() => setOpenAt(i)} />
        ))}
        {hidden > 0 ? (
          <Button
            data-testid='asset-row-more'
            variant='outline'
            size='sm'
            className='size-24 shrink-0 text-xs text-muted-foreground'
            onClick={() => setOpenAt(SQUARES_IN_THE_ROW)}
          >
            {t('chat.assets.more', { count: hidden })}
          </Button>
        ) : null}
      </div>
      {openAt === null ? null : (
        <AssetBox assets={assets} at={openAt} onMove={setOpenAt} onClose={close} />
      )}
    </>
  );
});

interface AssetThumbProps {
  /** The thing this square holds. */
  asset: ChatAsset;
  /** Open it for a proper look. */
  onOpen: () => void;
}

/**
 * One square in the row.
 *
 * A picture fills it, cropped. A clip does the same and says how long it runs,
 * because a still frame cannot. A track has no picture at all, so it gets a
 * face of its own: its name and its length, which is everything there is to
 * know about it from the outside.
 * @param root0 - The component props.
 * @param root0.asset - The thing this square holds.
 * @param root0.onOpen - Open it for a proper look.
 * @returns The square.
 */
function AssetThumb({ asset, onOpen }: AssetThumbProps): React.JSX.Element {
  return (
    <Button
      data-testid='asset-thumb'
      variant={null}
      size={null}
      onClick={onOpen}
      aria-label={asset.title}
      className='relative size-24 shrink-0 overflow-hidden rounded-content-sm border border-border bg-muted p-0'
    >
      {asset.kind === 'audio' ? (
        <span className='flex size-full flex-col items-center justify-center gap-1 px-2'>
          <AudioLines className='size-6 text-muted-foreground' aria-hidden='true' />
          <span className='w-full truncate text-2xs text-muted-foreground'>{asset.title}</span>
          {asset.duration === undefined ? null : (
            <span className='text-2xs text-muted-foreground'>{asset.duration}</span>
          )}
        </span>
      ) : (
        <>
          <img src={asset.url} alt='' className='size-full object-cover' loading='lazy' />
          {asset.kind === 'video' ? (
            <span className='absolute inset-x-1 bottom-1 flex items-center gap-1 text-2xs text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.6)]'>
              <Play className='size-3 fill-current' aria-hidden='true' />
              {asset.duration === undefined ? null : <span>{asset.duration}</span>}
            </span>
          ) : null}
        </>
      )}
    </Button>
  );
}

interface AssetBoxProps {
  /** Everything this turn found. */
  assets: ChatAsset[];
  /** Which one is on the stage. */
  at: number;
  /** Put another one on the stage. */
  onMove: (at: number) => void;
  /** Shut the box. */
  onClose: () => void;
}

/**
 * One asset, big, with the rest along the bottom to move between.
 * @param root0 - The component props.
 * @param root0.assets - Everything this turn found.
 * @param root0.at - Which one is on the stage.
 * @param root0.onMove - Put another one on the stage.
 * @param root0.onClose - Shut the box.
 * @returns The box.
 */
function AssetBox({ assets, at, onMove, onClose }: AssetBoxProps): React.JSX.Element {
  const t = useTranslation();
  const current = assets[Math.min(at, assets.length - 1)];
  return (
    <div className='absolute inset-0 z-40' data-testid='asset-box'>
      <Button
        variant={null}
        size={null}
        aria-label={t('common.close')}
        className='absolute inset-0 cursor-default bg-black/80'
        onClick={onClose}
      />
      <div className='absolute inset-4 z-10 flex flex-col overflow-hidden rounded-content-md border border-border bg-popover shadow-lg'>
        <div className='flex items-center justify-between gap-2 px-4 py-3'>
          <span className='truncate text-sm font-medium'>{current?.title}</span>
          <Button
            variant='ghost'
            size='sm'
            className='h-[var(--btn-compact)] shrink-0 px-2 text-xs text-muted-foreground'
            onClick={onClose}
          >
            {t('common.close')}
          </Button>
        </div>
        <div className='mx-4 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-content-sm bg-muted'>
          {current === undefined || current.kind === 'audio' ? (
            <AudioLines className='size-10 text-muted-foreground' aria-hidden='true' />
          ) : (
            <img src={current.url} alt={current.title} className='max-h-full max-w-full object-contain' />
          )}
        </div>
        <div className='flex gap-2 px-4 py-3'>
          {assets.map((asset, i) => (
            <Button
              key={asset.url}
              data-testid='asset-box-thumb'
              variant={null}
              size={null}
              aria-label={asset.title}
              aria-current={i === at}
              onClick={() => onMove(i)}
              className={cn(
                'size-10 shrink-0 overflow-hidden rounded-chrome border p-0',
                i === at ? 'border-active-border' : 'border-transparent',
              )}
            >
              {asset.kind === 'audio' ? (
                <AudioLines className='size-4 text-muted-foreground' aria-hidden='true' />
              ) : (
                <img src={asset.url} alt='' className='size-full object-cover' loading='lazy' />
              )}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
