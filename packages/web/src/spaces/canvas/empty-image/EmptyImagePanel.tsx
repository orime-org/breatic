// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { ArrowUp, X } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { EmptyImageColorPicker } from '@web/spaces/canvas/empty-image/EmptyImageColorPicker';
import { CROP_RATIOS } from '@web/spaces/canvas/focus/crop-math';

import {
  EMPTY_IMAGE_COLORS,
  EMPTY_IMAGE_DEFAULT_COLOR,
} from '@web/spaces/canvas/empty-image/empty-image-colors';
import {
  EMPTY_IMAGE_DEFAULT,
  clampDimension,
  normalizeDimensionInput,
  sizeForRatio,
} from '@web/spaces/canvas/empty-image/empty-image-size';

/** The concrete blank-image spec the panel emits on Execute. */
export interface EmptyImageExecuteOpts {
  width: number;
  height: number;
  color: string;
}

interface EmptyImagePanelProps {
  /** Rasterise + write back the blank image (the container gates + uploads). */
  onExecute: (opts: EmptyImageExecuteOpts) => void;
  /** Close the panel without changing the node (Exit button, no side effects). */
  onExit: () => void;
}

/**
 * The reset-empty-image form (#1623): pick a ratio preset or type W/H, choose a
 * fill colour, then Execute to replace the node's image with a fresh blank PNG.
 * Presentational — it owns only local form state; the container gates, generates
 * the PNG, and writes it back through the upload pipeline.
 * @param root0 - Component props.
 * @param root0.onExecute - Rasterise + write back the blank image.
 * @param root0.onExit - Close the panel without changing the node.
 * @returns The panel body (rendered inside the container's `NodeToolbar`).
 */
export function EmptyImagePanel({
  onExecute,
  onExit,
}: EmptyImagePanelProps): React.JSX.Element {
  const t = useTranslation();
  const [width, setWidth] = React.useState(String(EMPTY_IMAGE_DEFAULT));
  const [height, setHeight] = React.useState(String(EMPTY_IMAGE_DEFAULT));
  const [color, setColor] = React.useState(EMPTY_IMAGE_DEFAULT_COLOR);
  // Which ratio preset is active (highlighted); cleared once W/H is hand-edited.
  const [activeRatio, setActiveRatio] = React.useState<number | null>(1);

  // Focus border matches the shadcn Input standard (`border-active-border`), so
  // the W/H fields highlight the same as every other input in the app.
  const inputClass =
    'w-16 rounded-content-sm border border-border bg-transparent px-2 py-1 text-sm ' +
    'tabular-nums text-popover-foreground transition-colors focus-visible:border-active-border focus-visible:outline-none';

  return (
    <div className='flex w-[min(340px,92vw)] flex-col gap-3 rounded-overlay border border-border bg-popover p-3 text-popover-foreground shadow-md'>
      <div className='flex items-center justify-between'>
        <span className='text-sm font-medium'>{t('canvas.emptyImage.title')}</span>
        <button
          type='button'
          data-testid='empty-image-exit'
          aria-label={t('canvas.emptyImage.exit')}
          onClick={onExit}
          className='flex h-7 w-7 items-center justify-center rounded-overlay text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          <X className='h-4 w-4' aria-hidden='true' />
        </button>
      </div>

      {/* Ratio presets — clicking one derives a concrete W/H (D3). */}
      <div className='flex flex-wrap gap-1'>
        {CROP_RATIOS.map((r) => (
          <button
            key={r.key}
            type='button'
            data-testid={`empty-image-ratio-${r.key}`}
            aria-pressed={activeRatio === r.value}
            onClick={() => {
              const size = sizeForRatio(r.value);
              setWidth(String(size.width));
              setHeight(String(size.height));
              setActiveRatio(r.value);
            }}
            className={
              'rounded-content-sm border px-2 py-1 text-xs tabular-nums transition-colors ' +
              (activeRatio === r.value
                ? 'border-border bg-accent text-accent-foreground'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground')
            }
          >
            {r.key}
          </button>
        ))}
      </div>

      {/* Manual W/H — editing either clears the active ratio (D3). */}
      <div className='flex items-center gap-2 text-xs text-muted-foreground'>
        <label className='flex items-center gap-1'>
          {t('canvas.emptyImage.width')}
          <input
            type='text'
            inputMode='numeric'
            data-testid='empty-image-width'
            value={width}
            onChange={(e) => {
              // Plain field, digits only — no native spinner (type='number').
              setWidth(e.target.value.replace(/[^0-9]/g, ''));
              setActiveRatio(null);
            }}
            onBlur={() => setWidth(normalizeDimensionInput(width))}
            className={inputClass}
          />
        </label>
        <span aria-hidden='true'>×</span>
        <label className='flex items-center gap-1'>
          {t('canvas.emptyImage.height')}
          <input
            type='text'
            inputMode='numeric'
            data-testid='empty-image-height'
            value={height}
            onChange={(e) => {
              // Plain field, digits only — no native spinner (type='number').
              setHeight(e.target.value.replace(/[^0-9]/g, ''));
              setActiveRatio(null);
            }}
            onBlur={() => setHeight(normalizeDimensionInput(height))}
            className={inputClass}
          />
        </label>
      </div>

      {/* Fill colour: fixed swatches + a custom picker (D2). */}
      <div className='flex flex-wrap items-center gap-1.5'>
        {EMPTY_IMAGE_COLORS.map((c) => (
          <button
            key={c.key}
            type='button'
            data-testid={`empty-image-color-${c.key}`}
            aria-label={t(`canvas.emptyImage.color.${c.key}`)}
            aria-pressed={color.toLowerCase() === c.hex.toLowerCase()}
            onClick={() => setColor(c.hex)}
            style={{ backgroundColor: c.hex }}
            className={
              'h-5 w-5 rounded-full border transition-transform ' +
              (color.toLowerCase() === c.hex.toLowerCase()
                ? 'border-ring ring-1 ring-ring'
                : 'border-border hover:scale-110')
            }
          />
        ))}
      </div>

      {/* Custom colour picker (left, shows the current colour + opens a
          react-colorful popover that follows the canvas) + Execute (right). */}
      <div className='flex items-center justify-between'>
        <EmptyImageColorPicker value={color} onChange={setColor} />
        <button
          type='button'
          data-testid='empty-image-execute'
          aria-label={t('canvas.emptyImage.execute')}
          onClick={() =>
            onExecute({
              width: clampDimension(Number(width)),
              height: clampDimension(Number(height)),
              color,
            })
          }
          className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          <ArrowUp className='h-4 w-4' aria-hidden='true' />
        </button>
      </div>
    </div>
  );
}
