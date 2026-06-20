// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';
import {
  GROUP_BACKGROUND_OPTIONS,
  groupBackgroundStyle,
} from '@web/spaces/canvas/group-background';

interface GroupBackgroundPickerProps {
  /** Whether the swatch dropdown is open (controlled, like the context menus). */
  open: boolean;
  /** Open-state change (Escape / outside click). */
  onOpenChange: (open: boolean) => void;
  /** The group's current stored token, or `undefined` for no color. */
  value: string | undefined;
  /** Apply a tint token, or `undefined` to clear it. */
  onPick: (value: string | undefined) => void;
}

/**
 * The group background tint picker — a swatch button showing the current tint
 * that opens a row of choices (no color + the 4 status colors). Lives in the
 * group's floating selection toolbar; the parent owns the open state + wires
 * `onPick` to the Yjs `setGroupBackground` write.
 * @param root0 - Component props.
 * @param root0.open - Whether the dropdown is open.
 * @param root0.onOpenChange - Open-state change callback.
 * @param root0.value - The group's current tint token (or undefined for no color).
 * @param root0.onPick - Apply / clear the tint.
 * @returns The background-color picker control.
 */
export function GroupBackgroundPicker({
  open,
  onOpenChange,
  value,
  onPick,
}: GroupBackgroundPickerProps): React.JSX.Element {
  const t = useTranslation();
  const current = groupBackgroundStyle(value);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type='button'
          data-testid='group-bg-trigger'
          aria-label={t('canvas.group.background')}
          className='flex h-6 w-6 items-center justify-center rounded-chrome hover:bg-accent'
        >
          <span
            className='h-3.5 w-3.5 rounded-full border border-border'
            style={current ? { backgroundColor: current } : undefined}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align='start'
        data-testid='group-bg-list'
        // `w-fit min-w-0` overrides shadcn's default `min-w-[8rem]` so the
        // list hugs the single column of swatches instead of a wide box.
        className='flex w-fit min-w-0 flex-col gap-1 p-1'
      >
        {GROUP_BACKGROUND_OPTIONS.map((opt) => {
          const dot = groupBackgroundStyle(opt.value);
          return (
            <DropdownMenuItem
              key={opt.key}
              data-testid={`group-bg-${opt.key}`}
              aria-label={t(opt.labelKey)}
              onSelect={() => onPick(opt.value)}
              className={cn(
                'h-6 w-6 justify-center rounded-chrome p-0',
                opt.value === value ? 'ring-1 ring-status-selected' : '',
              )}
            >
              <span
                className='h-4 w-4 rounded-full border border-border'
                style={dot ? { backgroundColor: dot } : undefined}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
