// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { AudioLines, Play } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';

import { ColumnBox } from '@web/pages/project/chat/ColumnBox';
import type { ChatAsset } from '@web/pages/project/chat/types';

/** A square, and the gap before the next one. Both from the classes below. */
const SQUARE_PX = 96;
const GAP_PX = 8;

/**
 * What the row has to work with before it has been measured.
 *
 * The Agent column's floor is 320 and the message list pads it by 12 a side,
 * so this is the least room the row can ever have. Starting here rather than
 * at nothing means the first frame draws what will certainly fit, and the
 * measurement that follows in the same frame only ever adds.
 */
const NARROWEST_ROW_PX = 296;

/**
 * How many squares fit a row this wide, keeping room for the button.
 *
 * A count decided in advance cannot be right: the column runs from 320 to
 * 640, and at its narrowest the row has 296px to work with -- four squares
 * want 408, so the fourth and the button after it were both being cut off by
 * the row's own `overflow-hidden`, with nothing on screen saying so.
 *
 * Measured, nothing reflows either: widening the column appends squares at
 * the end and narrowing it takes them back behind the button, and the ones in
 * between never move. What the row must not do is wrap or scroll, and it
 * still does neither.
 * @param width - How much room the row has.
 * @param total - How many there are in all.
 * @returns How many to draw, at least one.
 */
export function squaresThatFit(width: number, total: number): number {
  const fit = Math.floor((width + GAP_PX) / (SQUARE_PX + GAP_PX));
  // The button is a square too, so it costs one of them -- but only when
  // there is something to put behind it.
  return Math.max(1, fit >= total ? total : fit - 1);
}

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

  const row = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = row.current;
    if (el === null) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry?.contentRect.width ?? 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const shown = assets.slice(0, squaresThatFit(width || NARROWEST_ROW_PX, assets.length));
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
            className='size-24 shrink-0 text-xs text-muted-foreground'
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
      title={current?.title}
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
                {asset.kind === 'audio' ? (
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
        {current === undefined || current.kind === 'audio' ? (
          <AudioLines className='size-10 text-muted-foreground' aria-hidden='true' />
        ) : (
          <img src={current.url} alt={current.title} className='max-h-full max-w-full object-contain' />
        )}
      </div>
    </ColumnBox>
  );
}
