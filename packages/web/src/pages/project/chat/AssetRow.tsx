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
  // The first of the ones the row had no slot for, which is the picture the
  // count stands on. `hidden` is above zero only when the turn found more than
  // there are slots, and `planRow` then leaves `shown` one below that, so this
  // index is inside the array whenever the button is drawn -- reading it
  // through a check rather than asserting is what tells the compiler so.
  const behind = hidden > 0 ? assets[shown] : undefined;

  return (
    <>
      <div ref={room} data-testid='asset-row' className='mt-[0.85em] flex gap-2'>
        {assets.slice(0, shown).map((asset, i) => (
          <AssetSquare
            key={i}
            testId='asset-thumb'
            src={asset.thumbnailUrl}
            label={asset.title}
            size={square}
            onOpen={() => setOpenAt(i)}
          />
        ))}
        {behind === undefined ? null : (
          <AssetSquare
            testId='asset-row-more'
            src={behind.thumbnailUrl}
            size={square}
            onOpen={() => setOpenAt(shown)}
          >
            {/* The picture underneath is whatever the search found -- snow, a
              white wall -- and the number has to be read on it either way.
              55% is what that costs: over white it comes to #737373, and white
              text on it is 4.74:1, past the 4.5:1 that 12px at 500 needs. */}
            <span
              data-testid='asset-row-more-scrim'
              className='absolute inset-0 flex items-center justify-center bg-black/55 text-xs font-medium text-white'
            >
              {t('chat.assets.more', { count: hidden })}
            </span>
          </AssetSquare>
        )}
      </div>
      <AssetBox assets={assets} at={openAt} onMove={setOpenAt} onClose={close} />
    </>
  );
});

interface AssetSquareProps {
  /** Which square this is, for the tests and the styles that reach for one. */
  testId: string;
  /** The picture that fills it. */
  src: string;
  /**
   * What to call it, where the picture is all there is to go on.
   *
   * The square holding the count has its own words in it, so it names itself.
   */
  label?: string;
  /** How large to draw it, as the row divided its room. */
  size: { width: string; height: string };
  /** Open it for a proper look. */
  onOpen: () => void;
  /** Drawn over the picture, for a square that says something as well. */
  children?: React.ReactNode;
}

/**
 * One square in the row.
 *
 * The picture fills it, cropped. Its name is in the box, which is where there
 * is room to read it. `bg-muted` is the ground it loads onto, the same recess
 * every square in the row shows before its own picture arrives.
 * @param root0 - The component props.
 * @param root0.testId - Which square this is.
 * @param root0.src - The picture that fills it.
 * @param root0.label - What to call it.
 * @param root0.size - How large to draw it.
 * @param root0.onOpen - Open it for a proper look.
 * @param root0.children - Drawn over the picture.
 * @returns The square.
 */
function AssetSquare({
  testId,
  src,
  label,
  size,
  onOpen,
  children,
}: AssetSquareProps): React.JSX.Element {
  return (
    <Button
      data-testid={testId}
      variant={null}
      size={null}
      style={size}
      onClick={onOpen}
      aria-label={label}
      className='relative shrink-0 overflow-hidden rounded-content-sm border border-border bg-muted'
    >
      <img src={src} alt='' className='size-full object-cover' loading='lazy' />
      {children}
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
                // The ring is one pixel of `--color-active-border`, which is
                // the muted foreground: a hairline of mid grey. Against the
                // picture's own pixels it is whatever the photograph happens
                // to be, so 2px of the panel behind it gives the line two
                // edges to be read against.
                className={cn(
                  'size-10 shrink-0 overflow-hidden rounded-chrome border p-0.5',
                  i === at ? 'border-active-border' : 'border-transparent',
                )}
              >
                {/* Its own radius, because the clip that rounds the others is
                  the button's and the picture no longer reaches it: inset by
                  2px, the corner sits inside the rounded rectangle and comes
                  out square. 4px is what a 6px outer corner leaves at that
                  depth. */}
                <img
                  src={asset.thumbnailUrl}
                  alt=''
                  className='size-full rounded-chrome-sm object-cover'
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
