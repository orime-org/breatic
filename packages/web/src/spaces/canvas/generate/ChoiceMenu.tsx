// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { ChevronDown } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { cn } from '@web/lib/utils';

export interface ChoiceMenuOption {
  /** What picking it writes. */
  value: string | number;
  /** Its name on screen. */
  label: string;
  /** Test id of its row. */
  testId: string;
  /** Whether it cannot be picked now. */
  disabled?: boolean;
}

interface ChoiceMenuProps {
  /** The option held. */
  value: string | number | undefined;
  /** Every option, in display order. */
  options: readonly ChoiceMenuOption[];
  /** Called with a newly picked option; picking the held one only closes the list. */
  onSelect: (value: string | number) => void;
  /** Test id of the trigger. */
  triggerTestId: string;
  /** The trigger's shape. */
  triggerClassName: string;
  /** Which side of the trigger the list opens on. */
  side?: 'top' | 'bottom';
  /** Whether the list moves to stay on screen; off where something else repositions it. */
  avoidCollisions?: boolean;
  /** Told when the list opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /** Called instead of opening while a rule holds the choice (inner#1691). */
  onLocked?: () => void;
  /** Whether the trigger cannot be pressed. */
  disabled?: boolean;
  /** Names the trigger for its label element. */
  id?: string;
}

/**
 * A single choice shown as the held option, which opens a list of all of
 * them: the same list as the language and theme menus, a column of menu-item
 * buttons where the held one is filled. A check mark would read as "more
 * than one can be on" (DESIGN.md §5.3).
 * @param root0 - Props.
 * @param root0.value - The option held.
 * @param root0.options - Every option.
 * @param root0.onSelect - Called with a newly picked option.
 * @param root0.triggerTestId - Test id of the trigger.
 * @param root0.triggerClassName - The trigger's shape.
 * @param root0.side - Which side the list opens on.
 * @param root0.avoidCollisions - Whether the list moves to stay on screen.
 * @param root0.onOpenChange - Told when the list opens or closes.
 * @param root0.onLocked - Called instead of opening while a rule holds it.
 * @param root0.disabled - Whether the trigger cannot be pressed.
 * @param root0.id - Names the trigger for its label element.
 * @returns The menu.
 */
export function ChoiceMenu({ value, options, onSelect, triggerTestId, triggerClassName, side = 'bottom', avoidCollisions = true,
  onOpenChange, onLocked, disabled, id }: ChoiceMenuProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const change = React.useCallback((next: boolean): void => {
    if (next && onLocked !== undefined) {
      onLocked();
      return;
    }
    setOpen(next);
    onOpenChange?.(next);
  }, [onLocked, onOpenChange]);
  const held = options.find((option) => option.value === value);
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>
        <Button type='button' variant={null} size={null} id={id} data-testid={triggerTestId} disabled={disabled}
          aria-disabled={onLocked === undefined ? undefined : true}
          className={cn('flex h-8 items-center gap-1 whitespace-nowrap border border-border bg-background px-2.5 text-xs text-foreground transition-colors hover-enabled:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            onLocked !== undefined && 'opacity-50', triggerClassName)}>
          {/* Falls back to the raw value when the held one is not offered, so it still reads as something. */}
          <span className='truncate'>{held?.label ?? (value === undefined ? '' : String(value))}</span>
          <ChevronDown className='size-3.5 shrink-0 opacity-60' aria-hidden='true' />
        </Button>
      </PopoverTrigger>
      <PopoverContent side={side} align='start' avoidCollisions={avoidCollisions} className='w-auto min-w-[10rem] p-1 shadow-md'>
        <div className='flex flex-col gap-0.5'>
          {options.map((option) => (
            <Button key={String(option.value)} variant='ghost' size='menu-item' aria-pressed={option.value === value} data-testid={option.testId}
              disabled={option.disabled}
              className={cn('justify-start', option.value === value && 'bg-accent-strong hover-enabled:bg-accent-strong')}
              onClick={() => {
                if (option.value !== value) onSelect(option.value);
                change(false);
              }}>
              {option.label}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
