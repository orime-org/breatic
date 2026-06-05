// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { useTranslation } from '@web/i18n/use-translation';
import type { SlugError } from '@web/pages/studio/container/dialogs/slug-util';

interface SlugFieldProps {
  id: string;
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  /** The current validation error (computed by the parent), or `null`. */
  error: SlugError;
  /** Length bounds, used to fill the length-error message. */
  bounds: { min: number; max: number };
}

/**
 * The slug input used by the create dialogs (spec §3.12): a labeled text field
 * that surfaces the active validation error (format / length / reserved /
 * taken) as a destructive helper line wired via `aria-describedby`. The parent
 * owns the value and the error; this component only renders + reports changes.
 * @param props the field id, label, value, change handler, error and bounds.
 * @param props.id the field id.
 * @param props.label the display label.
 * @param props.placeholder the input placeholder.
 * @param props.value the current field value.
 * @param props.onChange the value change handler.
 * @param props.error the current validation error.
 * @param props.bounds the slug length bounds.
 * @returns the slug field.
 */
export function SlugField({
  id,
  label,
  placeholder,
  value,
  onChange,
  error,
  bounds,
}: SlugFieldProps): React.JSX.Element {
  const t = useTranslation();
  const message =
    error === 'format'
      ? t('studio.container.dialog.slugFormat')
      : error === 'length'
        ? t('studio.container.dialog.slugLength', {
          min: bounds.min,
          max: bounds.max,
        })
        : error === 'reserved'
          ? t('studio.container.dialog.slugReserved')
          : error === 'taken'
            ? t('studio.container.dialog.slugTaken')
            : null;
  return (
    <div className='flex flex-col gap-1.5'>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-invalid={error !== null}
        aria-describedby={message ? `${id}-error` : undefined}
        autoComplete='off'
        autoCapitalize='none'
        spellCheck={false}
      />
      {message ? (
        <p id={`${id}-error`} className='text-xs text-destructive'>
          {message}
        </p>
      ) : null}
    </div>
  );
}
