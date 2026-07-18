// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { ChevronDown } from 'lucide-react';
import * as React from 'react';

import type { ModelEntry } from '@breatic/shared';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { useTranslation } from '@web/i18n/use-translation';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

/** The subset of generate params this picker edits. */
interface RatioResolutionValue {
  aspect_ratio?: string;
  resolution?: string;
}

interface RatioResolutionPickerProps {
  /** The current model, whose params define the allowed ratios / resolutions. */
  model: ModelEntry;
  /** The current ratio + resolution selection. */
  value: RatioResolutionValue;
  /** Called with the changed field ({ aspect_ratio } or { resolution }). */
  onChange: (partial: RatioResolutionValue) => void;
}

/**
 * Reads a param's allowed values as strings, or an empty list when the model
 * does not define that param.
 * @param model - The current model.
 * @param key - The param key (`aspect_ratio` / `resolution`).
 * @returns The allowed values as strings.
 */
function paramValues(model: ModelEntry, key: string): string[] {
  // model.params is trusted (the catalog is sanitized at the API boundary):
  // `values` is a readonly array or undefined, so a truthiness check suffices.
  const values = model.params?.[key]?.values;
  return values ? values.map((v) => String(v)) : [];
}

/**
 * The Generate panel's ratio + resolution picker: a pill showing the current
 * `ratio · resolution` that opens a popover with a resolution segmented row and
 * a ratio grid, both sourced from the current model's params (a model without a
 * given param omits that section). Closes on Escape or an outside click.
 * @param root0 - Component props.
 * @param root0.model - The current model.
 * @param root0.value - The current ratio + resolution.
 * @param root0.onChange - Called with the changed field.
 * @returns The ratio + resolution picker.
 */
export const RatioResolutionPicker = React.memo(function RatioResolutionPicker({
  model,
  value,
  onChange,
}: RatioResolutionPickerProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  // Keep the popover glued to its trigger as the canvas pans / zooms, matching
  // the generate panel (a ReactFlow NodeToolbar that tracks its node).
  useFollowCanvasViewport(open);
  const ratios = paramValues(model, 'aspect_ratio');
  const resolutions = paramValues(model, 'resolution');
  const label = [value.aspect_ratio, value.resolution].filter(Boolean).join(' · ');
  // max-w + truncate: catalog values carry no length cap at the sanitize
  // boundary — a verbose value must clip inside the w-64 popover, not overflow
  // it (same class as the ModelPicker display_name fix).
  const optionClass =
    'max-w-full truncate rounded-overlay border border-border px-2 py-1 text-xs text-foreground transition-colors ' +
    'hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ' +
    'aria-[current=true]:border-active-border aria-[current=true]:bg-accent';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-testid='generate-ratio-trigger'
          className='flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border bg-background px-2.5 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          {/* truncate: catalog aspect_ratio/resolution values carry no length
              cap at the sanitize boundary — unbounded, a verbose value would
              stretch the panel footer row (same class as the ModelPicker
              display_name fix). */}
          <span className='max-w-[10rem] truncate'>{label}</span>
          <ChevronDown
            className='h-3.5 w-3.5 shrink-0 opacity-60'
            aria-hidden='true'
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='center'
        // Freeze on open (user 2026-07-18): no collision flip/shift — clips at
        // the screen edge like the generate panel instead of jumping near a border.
        avoidCollisions={false}
        aria-label={t('canvas.generatePanel.ratio')}
        className='w-64 p-3'
      >
        {resolutions.length > 0 ? (
          <div className='mb-3'>
            <p className='mb-1.5 text-xs font-medium text-muted-foreground'>
              {t('canvas.generatePanel.resolution')}
            </p>
            <div className='flex flex-wrap gap-1.5'>
              {resolutions.map((r) => (
                <button
                  key={r}
                  type='button'
                  data-testid={`generate-resolution-option-${r}`}
                  aria-current={value.resolution === r}
                  onClick={() => onChange({ resolution: r })}
                  className={optionClass}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {ratios.length > 0 ? (
          <div>
            <p className='mb-1.5 text-xs font-medium text-muted-foreground'>
              {t('canvas.generatePanel.ratio')}
            </p>
            <div className='flex flex-wrap gap-1.5'>
              {ratios.map((r) => (
                <button
                  key={r}
                  type='button'
                  data-testid={`generate-ratio-option-${r}`}
                  aria-current={value.aspect_ratio === r}
                  onClick={() => onChange({ aspect_ratio: r })}
                  className={optionClass}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
});
