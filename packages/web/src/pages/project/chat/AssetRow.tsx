// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { AudioLines, Play } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';

import { ColumnBox } from '@web/pages/project/chat/ColumnBox';
import { fitsInRow, useRowMeasure } from '@web/pages/project/chat/row-fit';
import type { ChatAsset } from '@web/pages/project/chat/types';

/** A square, the gap before the next one, and the button that opens the rest. */
const SQUARE_PX = 46;
const GAP_PX = 8;

/** The square, as a class. Kept in one place so the arithmetic cannot drift from it. */
const SQUARE_CLASS = 'size-[46px] shrink-0';

/**
 * What the row has before it has been measured.
 *
 * The Agent column's floor is 320 and the message list pads it by 12 a side,
 * so this is the least room the row can ever have: the first frame draws what
 * will certainly fit, and the measurement that follows only ever adds.
 */
const NARROWEST_ROW_PX = 296;

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

  const { row, rowPx } = useRowMeasure();
  // Every square is the one size, so what fits is arithmetic on that size --
  // the source row beside this one measures instead, because its chips are
  // each their own width. The rule the two share is `fitsInRow`.
  const shown = assets.slice(
    0,
    fitsInRow(
      assets.map(() => SQUARE_PX),
      GAP_PX,
      rowPx === 0 ? NARROWEST_ROW_PX : rowPx,
      SQUARE_PX,
    ),
  );
  const hidden = assets.length - shown.length;

  return (
    <>
      <div ref={row} data-testid='asset-row' className='mt-[0.85em] flex gap-2 overflow-hidden'>
        {shown.map((asset, i) => (
          <AssetThumb key={asset.url} asset={asset} onOpen={() => setOpenAt(i)} />
        ))}
        {hidden > 0 ? (
          <Button
            data-testid='asset-row-more'
            variant='outline'
            size='sm'
            className={cn(SQUARE_CLASS, 'text-xs text-muted-foreground')}
            onClick={() => setOpenAt(shown.length)}
          >
            {t('chat.assets.more', { count: hidden })}
          </Button>
        ) : null}
      </div>
      <AssetBox assets={assets} at={openAt} onMove={setOpenAt} onClose={close} />
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
 * because a still frame cannot. A track has no picture at all, so it shows
 * what it is; its name and its length are in the box, which is where there is
 * room to read them.
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
      className={cn(
        SQUARE_CLASS,
        'relative overflow-hidden rounded-content-sm border border-border bg-muted p-0',
      )}
    >
      {asset.kind !== 'image' ? (
        <AssetFace asset={asset} />
      ) : (
        <img src={asset.url} alt='' className='size-full object-cover' loading='lazy' />
      )}
    </Button>
  );
}

/**
 * The face a square wears when there is no picture to fill it.
 *
 * `show_search_results` gives one address per result, described as the asset
 * or its page, so a clip's address is the clip -- an `img` pointed at it
 * draws nothing. A clip says how long it runs, which is what a still frame
 * could not have said either; a track says that it is one.
 * @param root0 - The component props.
 * @param root0.asset - The thing this square holds.
 * @returns The face.
 */
function AssetFace({ asset }: { asset: ChatAsset }): React.JSX.Element {
  return (
    <span className='flex size-full flex-col items-center justify-center gap-0.5'>
      {asset.kind === 'video' ? (
        <Play className='size-4 fill-current text-muted-foreground' aria-hidden='true' />
      ) : (
        <AudioLines className='size-4 text-muted-foreground' aria-hidden='true' />
      )}
      {asset.duration === undefined ? null : (
        <span className='text-2xs text-muted-foreground'>{asset.duration}</span>
      )}
    </span>
  );
}

interface AssetBoxProps {
  /** Everything this turn found. */
  assets: ChatAsset[];
  /** Which one is on the stage, or none when the box is shut. */
  at: number | null;
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
  const current = at === null ? undefined : assets[Math.min(at, assets.length - 1)];
  return (
    <ColumnBox
      open={at !== null}
      onOpenChange={onClose}
      testId='asset-box'
      title={
        current === undefined ? null : (
          <span className='flex items-baseline gap-2'>
            <span className='truncate'>{current.title}</span>
            {current.duration === undefined ? null : (
              <span className='shrink-0 text-xs font-normal text-muted-foreground'>
                {current.duration}
              </span>
            )}
          </span>
        )
      }
      footer={
        // Its own scroller rather than a row that runs off the edge: a turn
        // can find more of these than the column is wide, and the ones past
        // the edge would be the only way back to them.
        <ScrollArea scrollbars='horizontal' viewportClassName='px-4 pb-3 pt-3'>
          <div className='flex gap-2'>
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
                {asset.kind !== 'image' ? (
                  <AudioLines className='size-4 text-muted-foreground' aria-hidden='true' />
                ) : (
                  <img src={asset.url} alt='' className='size-full object-cover' loading='lazy' />
                )}
              </Button>
            ))}
          </div>
        </ScrollArea>
      }
    >
      <div className='mx-4 mt-3 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-content-sm bg-muted'>
        {current === undefined || current.kind !== 'image' ? (
          <AudioLines className='size-10 text-muted-foreground' aria-hidden='true' />
        ) : (
          <img src={current.url} alt={current.title} className='max-h-full max-w-full object-contain' />
        )}
      </div>
    </ColumnBox>
  );
}
