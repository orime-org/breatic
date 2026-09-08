// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One switch inside a params popover: its name on the left, the state word and
 * the switch on the right.
 *
 * Shared by the audio and video pickers so a switch reads the same wherever it
 * appears — the name at the same weight and colour a param name carries in the
 * groups above and below it, and the switch on the popover's right edge, where
 * it lands on the same vertical line as every other switch regardless of how
 * wide the state word beside it happens to be.
 *
 * The whole row is the `<label>`, so the name is part of the hit target rather
 * than something to aim past. The state word is what says which way the switch
 * is thrown: the track alone carries no word, so an off switch and a disabled
 * control look alike (contrast measured 2026-09-06: track against the popover
 * ground is 1.36:1, under SC 1.4.11's 3:1).
 */

import * as React from 'react';

import { Switch } from '@web/components/ui/switch';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';

interface ParamToggleRowProps {
  /** The switch's element id, and its test id. */
  id: string;
  /** The translated param name. */
  label: string;
  /** Whether the param is on. */
  checked: boolean;
  /** Called with the value the user threw the switch to. */
  onCheckedChange: (next: boolean) => void;
  /** Row spacing from the parent. */
  className?: string;
}

/**
 * Renders one switch row.
 * @param root0 - Component props.
 * @param root0.id - The switch's element and test id.
 * @param root0.label - The translated param name.
 * @param root0.checked - Whether the param is on.
 * @param root0.onCheckedChange - Called with the new value.
 * @param root0.className - Row spacing from the parent.
 * @returns The switch row.
 */
export function ParamToggleRow({
  id,
  label,
  checked,
  onCheckedChange,
  className,
}: ParamToggleRowProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center justify-between gap-3',
        className,
      )}
    >
      <span className='text-xs font-medium text-muted-foreground'>{label}</span>
      <span className='flex items-center gap-2'>
        {/* The row is the switch's label, so its text is the switch's name.
            Holding the state word out of that keeps the name the param's name
            and nothing else — the switch already carries its own state. */}
        <span aria-hidden='true' className='text-xs text-muted-foreground'>
          {checked
            ? t('canvas.generatePanel.switchOn')
            : t('canvas.generatePanel.switchOff')}
        </span>
        <Switch
          id={id}
          checked={checked}
          onCheckedChange={onCheckedChange}
          data-testid={id}
        />
      </span>
    </label>
  );
}
