// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import type { ModelEntry } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';

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
  // Escape closes the popover. Handled at the document level (not on the
  // dialog element) so it works regardless of focus and keeps the dialog
  // container free of direct keyboard listeners.
  React.useEffect(() => {
    if (!open) return undefined;
    /**
     * Document keydown handler: Escape closes the popover.
     * @param e - The keyboard event.
     */
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  const ratios = paramValues(model, 'aspect_ratio');
  const resolutions = paramValues(model, 'resolution');
  const label = [value.aspect_ratio, value.resolution].filter(Boolean).join(' · ');
  const optionClass =
    'rounded-overlay border border-border px-2 py-1 text-xs text-foreground transition-colors ' +
    'hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ' +
    'aria-[current=true]:border-primary aria-[current=true]:bg-accent';
  return (
    <div className='relative shrink-0'>
      <button
        type='button'
        data-testid='generate-ratio-trigger'
        onClick={() => setOpen((o) => !o)}
        aria-haspopup='dialog'
        aria-expanded={open}
        className='flex h-8 items-center gap-1 whitespace-nowrap rounded-full border border-border bg-background px-2.5 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
      >
        {label}
      </button>
      {open ? (
        <>
          <div
            aria-hidden='true'
            className='fixed inset-0 z-40'
            onClick={() => setOpen(false)}
          />
          <div
            role='dialog'
            aria-label={t('canvas.generatePanel.ratio')}
            className='absolute bottom-full left-0 z-50 mb-1 w-64 rounded-overlay border border-border bg-popover p-3 shadow-md'
          >
            {resolutions.length > 0 ? (
              <div className='mb-3'>
                <p className='mb-1.5 text-xs font-medium text-muted-foreground'>
                  {t('canvas.generatePanel.resolution')}
                </p>
                <div className='flex gap-1.5'>
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
          </div>
        </>
      ) : null}
    </div>
  );
});
