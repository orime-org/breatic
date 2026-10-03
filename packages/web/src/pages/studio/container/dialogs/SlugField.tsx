// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { useTranslation } from '@web/i18n/use-translation';
import type { SlugCheck } from '@web/pages/studio/container/dialogs/slug-util';

interface SlugFieldProps {
  id: string;
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  /** Where the slug stands now; the caller owns how it is worked out. */
  check: SlugCheck;
  /** Length bounds, filled into the length reason. */
  bounds: { min: number; max: number };
  /** What the field is for and its rules, shown while it is empty. */
  helper: string;
  /**
   * Greys the input out while an edit could not be submitted anyway — the
   * rename dialog sets it while ANY settings save is in flight, which is the
   * same condition that holds its Confirm button back. Typing into a field
   * whose Confirm is unreachable only looks like it will work.
   */
  disabled?: boolean;
}

/** Colour of the hint line for each state. */
const HINT_TONE: Record<SlugCheck['state'], string> = {
  empty: 'text-muted-foreground',
  checking: 'text-muted-foreground',
  invalid: 'text-status-error-foreground',
  valid: 'text-status-success-foreground',
};

/**
 * The slug input shared by the create-studio, create-project/collection,
 * rename-studio and onboarding forms. One line under the input carries the
 * whole story: the description while the field is empty, a pending line while
 * a check runs, then the reason it was refused (red) or that it is available
 * (green).
 * @param props the field id, label, value, change handler, check, bounds and helper.
 * @param props.id the field id.
 * @param props.label the display label.
 * @param props.placeholder the input placeholder.
 * @param props.value the current field value.
 * @param props.onChange the value change handler.
 * @param props.check where the slug stands now.
 * @param props.bounds the slug length bounds.
 * @param props.helper the description shown while the field is empty.
 * @param props.disabled whether the input is greyed out (optional).
 * @returns the slug field.
 */
export function SlugField({
  id,
  label,
  placeholder,
  value,
  onChange,
  check,
  bounds,
  helper,
  disabled = false,
}: SlugFieldProps): React.JSX.Element {
  const t = useTranslation();
  const hintId = `${id}-hint`;
  const text =
    check.state === 'empty'
      ? helper
      : check.state === 'checking'
        ? t('studio.container.dialog.slugChecking')
        : check.state === 'valid'
          ? t('studio.container.dialog.slugAvailable')
          : check.reason === 'format'
            ? t('studio.container.dialog.slugFormat')
            : check.reason === 'length'
              ? t('studio.container.dialog.slugLength', {
                min: bounds.min,
                max: bounds.max,
              })
              : check.reason === 'reserved'
                ? t('studio.container.dialog.slugReserved')
                : t('studio.container.dialog.slugTaken');
  return (
    <div className='flex flex-col gap-1.5'>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={check.state === 'invalid'}
        aria-describedby={hintId}
        autoComplete='off'
        autoCapitalize='none'
        spellCheck={false}
      />
      <p
        id={hintId}
        data-testid={hintId}
        className={`text-xs ${HINT_TONE[check.state]}`}
      >
        {text}
      </p>
    </div>
  );
}
