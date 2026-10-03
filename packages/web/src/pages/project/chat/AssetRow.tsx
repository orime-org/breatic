// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';

import { CopyAnswerLabel } from '@web/pages/project/chat/copy-answer';
import { isCopied, useCopyAsset, type CopyAsset } from '@web/pages/project/chat/copy-asset';
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
  const copying = useCopyAsset();

  const { room, rowPx } = useRowMeasure();
  const { sizePx, shown, hidden } = planRow(assets.length, rowPx, GAP_PX);
  const square = { width: `${String(sizePx)}px`, height: `${String(sizePx)}px` };
  // The first of the ones the row had no slot for, which is the picture the
  // count stands on. `planRow` holds a picture back only by giving up a slot
  // for the count, so `shown` is then one below the slot count and at least
  // one picture short of the total: this is a real asset exactly when there
  // is a count to draw, and nothing at all when there is not.
  const behind = assets[shown];

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
            copy={<CopyAssetButton copying={copying} asset={asset} />}
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
      <AssetBox
        assets={assets}
        at={openAt}
        onMove={setOpenAt}
        onClose={close}
        copying={copying}
      />
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
  /** A copy button for the picture, in the square's top-right corner. */
  copy?: React.ReactNode;
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
 * @param root0.copy - A copy button for the picture.
 * @returns The square.
 */
function AssetSquare({
  testId,
  src,
  label,
  size,
  onOpen,
  children,
  copy,
}: AssetSquareProps): React.JSX.Element {
  // The copy button sits beside the open button rather than inside it: a
  // button in a button is not valid markup, and the outer one would take the
  // inner one's name and keys. The hover belongs to the cell, so it holds
  // while the pointer is on either of them.
  return (
    <div className='group relative shrink-0'>
      <Button
        data-testid={testId}
        variant={null}
        size={null}
        style={size}
        onClick={onOpen}
        aria-label={label}
        className={cn(
          'relative overflow-hidden rounded-content-sm border border-border bg-muted transition-colors',
          'group-hover:border-active-border',
          'after:pointer-events-none after:absolute after:inset-0 after:bg-white/0 after:transition-colors group-hover:after:bg-white/[0.08]',
        )}
      >
        <img src={src} alt='' className='size-full object-cover' loading='lazy' />
        {children}
      </Button>
      {copy}
    </div>
  );
}

interface CopyAssetButtonProps {
  /** The row's copy state. */
  copying: CopyAsset;
  /** The picture it copies. */
  asset: ChatAsset;
}

/**
 * The copy button in a square's top-right corner.
 *
 * Shown while the square is hovered or the button has the keyboard, and kept
 * up while it says copied. Hidden, it takes neither clicks nor a tab stop.
 * @param root0 - The component props.
 * @param root0.copying - The row's copy state.
 * @param root0.asset - The picture it copies.
 * @returns The button.
 */
function CopyAssetButton({ copying, asset }: CopyAssetButtonProps): React.JSX.Element {
  const t = useTranslation();
  const copied = isCopied(copying, asset);
  return (
    <span className='absolute right-1 top-1 inline-flex'>
      <Button
        data-testid='asset-copy'
        variant={null}
        size={null}
        aria-label={t('chat.action.copy')}
        onClick={() => copying.copy(asset)}
        className={cn(
          'inline-flex size-[18px] items-center justify-center rounded-chrome-sm border border-border bg-background text-foreground transition-opacity',
          !copied &&
            'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto',
        )}
      >
        {copied ? (
          <Check className='size-3' aria-hidden='true' />
        ) : (
          <Copy className='size-3' aria-hidden='true' />
        )}
      </Button>
      {copied ? <CopyAnswerLabel side='right' /> : null}
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
  /** The row's copy state, shared with the squares' copy buttons. */
  copying: CopyAsset;
}

/**
 * One asset, big, with the rest along the bottom to move between.
 * @param root0 - The component props.
 * @param root0.assets - Everything this turn found.
 * @param root0.at - Which one is on the stage.
 * @param root0.onMove - Put another one on the stage.
 * @param root0.onClose - Shut the box.
 * @param root0.copying - The row's copy state.
 * @returns The box.
 */
function AssetBox({ assets, at, onMove, onClose, copying }: AssetBoxProps): React.JSX.Element {
  const t = useTranslation();
  const current = at === null ? undefined : assets[Math.min(at, assets.length - 1)];
  const copied = current !== undefined && isCopied(copying, current);
  return (
    <ReplyBox
      open={at !== null}
      onOpenChange={onClose}
      testId='asset-box'
      title={current === undefined ? null : <span className='truncate'>{current.title}</span>}
      actions={
        current === undefined ? undefined : (
          <span className='relative inline-flex shrink-0'>
            <Button
              data-testid='asset-box-copy'
              variant='outline'
              size='sm'
              className='gap-1.5'
              onClick={() => copying.copy(current)}
            >
              {copied ? (
                <Check className='size-3.5' aria-hidden='true' />
              ) : (
                <Copy className='size-3.5' aria-hidden='true' />
              )}
              {t('chat.action.copy')}
            </Button>
            {copied ? <CopyAnswerLabel side='right' /> : null}
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
                  the button's and the picture no longer reaches it: 1px of
                  border and 2px of padding in, its corner sits inside the
                  rounded rectangle and comes out square. The clip runs at
                  6 - 1 = 5px and the picture is 2px inside that, so the
                  concentric answer is 3px; 4px is the nearest token, and on a
                  34px square the pixel between them does not read. */}
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
