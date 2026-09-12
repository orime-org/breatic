// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';

import { ReplyBox } from '@web/pages/project/chat/ReplyBox';
import { planRow, useRowMeasure } from '@web/pages/project/chat/row-fit';
import type { ChatAsset } from '@web/pages/project/chat/types';

/** The gap between two squares. Matches the `gap-2` the row is laid out with. */
const GAP_PX = 8;

interface AssetRowProps {
  /** What this turn found. */
  assets: ChatAsset[];
}

/**
 * What a turn found, as one row of squares.
 *
 * Squares whatever shape the picture is. A row that let each thumbnail keep
 * its own proportions reads as a pile rather than as a set, and what the
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

  const { room, rowPx } = useRowMeasure();
  const { sizePx, shown, hidden } = planRow(assets.length, rowPx, GAP_PX);
  const square = { width: `${String(sizePx)}px`, height: `${String(sizePx)}px` };

  return (
    <>
      <div ref={room} data-testid='asset-row' className='mt-[0.85em] flex gap-2'>
        {assets.slice(0, shown).map((asset, i) => (
          <AssetThumb key={i} asset={asset} size={square} onOpen={() => setOpenAt(i)} />
        ))}
        {hidden > 0 ? (
          <Button
            data-testid='asset-row-more'
            variant={null}
            size={null}
            style={square}
            // The same recess fill a square shows before its picture arrives,
            // so this reads as one of the row rather than as the panel showing
            // through a gap in it. It is the way to every picture the row had
            // no slot for -- seven of ten on a turn that found ten -- and the
            // quietest thing in the row is not that.
            className='shrink-0 rounded-content-sm border border-border bg-muted text-xs text-muted-foreground'
            onClick={() => setOpenAt(shown)}
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
  /** How large to draw it, as the row divided its room. */
  size: { width: string; height: string };
  /** Open it for a proper look. */
  onOpen: () => void;
}

/**
 * One square in the row.
 *
 * The picture fills it, cropped. Its name is in the box, which is where there
 * is room to read it.
 * @param root0 - The component props.
 * @param root0.asset - The thing this square holds.
 * @param root0.size - How large to draw it.
 * @param root0.onOpen - Open it for a proper look.
 * @returns The square.
 */
function AssetThumb({ asset, size, onOpen }: AssetThumbProps): React.JSX.Element {
  return (
    <Button
      data-testid='asset-thumb'
      variant={null}
      size={null}
      style={size}
      onClick={onOpen}
      aria-label={asset.title}
      className='relative shrink-0 overflow-hidden rounded-content-sm border border-border bg-muted p-0'
    >
      <img src={asset.thumbnailUrl} alt='' className='size-full object-cover' loading='lazy' />
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
    <ReplyBox
      open={at !== null}
      onOpenChange={onClose}
      testId='asset-box'
      title={current === undefined ? null : <span className='truncate'>{current.title}</span>}
      footer={
        // Its own scroller rather than a row that runs off the edge: a turn
        // can find more of these than the column is wide, and the ones past
        // the edge would be the only way back to them.
        <ScrollArea scrollbars='horizontal' viewportClassName='px-4 pb-3 pt-3'>
          <div className='flex gap-2'>
            {assets.map((asset, i) => (
              <Button
                key={i}
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
                <img
                  src={asset.thumbnailUrl}
                  alt=''
                  className='size-full object-cover'
                  loading='lazy'
                />
              </Button>
            ))}
          </div>
        </ScrollArea>
      }
    >
      <div className='mx-4 mt-3 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-content-sm bg-muted'>
        {current === undefined ? null : (
          <img
            src={current.thumbnailUrl}
            alt={current.title}
            className='max-h-full max-w-full object-contain'
          />
        )}
      </div>
    </ReplyBox>
  );
}
