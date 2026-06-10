import type { ComponentProps, ReactNode } from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight, Circle } from 'lucide-react';

import { cn } from '@web/lib/utils';

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

/**
 * Dropdown menu surface — `bg-popover` + border + `shadow-md` at `z-popover`,
 * 4px inner padding. Items use the neutral hover fill (`bg-muted`) on focus,
 * matching the ghost-button hover.
 * @param props - Radix Content props (`sideOffset`, …).
 * @returns The dropdown menu panel.
 */
export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>): ReactNode {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-[var(--z-popover)] min-w-[10rem] overflow-hidden rounded-overlay border border-border bg-popover p-1 text-popover-foreground shadow-md',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

const itemBase =
  'relative flex cursor-default select-none items-center gap-2 rounded-chrome px-2 py-1.5 text-sm outline-none transition-colors focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0';

/**
 * Standard menu item.
 * @param props - Radix Item props.
 * @returns A dropdown menu item.
 */
export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item>): ReactNode {
  return (
    <DropdownMenuPrimitive.Item className={cn(itemBase, className)} {...props} />
  );
}

/**
 * Checkbox menu item — left check mark when selected.
 * @param props - Radix CheckboxItem props (`checked`, …).
 * @returns A checkable dropdown menu item.
 */
export function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>): ReactNode {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      className={cn(itemBase, 'pl-8', className)}
      checked={checked}
      {...props}
    >
      <span className='absolute left-2 flex size-4 items-center justify-center'>
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className='size-4' strokeWidth={3} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

/**
 * Radio menu item — left dot when selected.
 * @param props - Radix RadioItem props (`value`, …).
 * @returns A radio dropdown menu item.
 */
export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.RadioItem>): ReactNode {
  return (
    <DropdownMenuPrimitive.RadioItem
      className={cn(itemBase, 'pl-8', className)}
      {...props}
    >
      <span className='absolute left-2 flex size-4 items-center justify-center'>
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle className='size-2 fill-current' />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

/**
 * Section label — muted, small.
 * @param props - Radix Label props.
 * @returns A dropdown section label.
 */
export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>): ReactNode {
  return (
    <DropdownMenuPrimitive.Label
      className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)}
      {...props}
    />
  );
}

/**
 * Thin divider between menu groups.
 * @param props - Radix Separator props.
 * @returns A dropdown separator line.
 */
export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>): ReactNode {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

/**
 * Right-aligned keyboard shortcut hint.
 * @param props - Native span props.
 * @returns A shortcut hint span.
 */
export function DropdownMenuShortcut({
  className,
  ...props
}: ComponentProps<'span'>): ReactNode {
  return (
    <span
      className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)}
      {...props}
    />
  );
}

/**
 * Submenu trigger — chevron on the right.
 * @param props - Radix SubTrigger props.
 * @returns A submenu trigger item.
 */
export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>): ReactNode {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(itemBase, 'data-[state=open]:bg-muted', className)}
      {...props}
    >
      {children}
      <ChevronRight className='ml-auto size-4' />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

/**
 * Submenu surface.
 * @param props - Radix SubContent props.
 * @returns The submenu panel.
 */
export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubContent>): ReactNode {
  return (
    <DropdownMenuPrimitive.SubContent
      className={cn(
        'z-[var(--z-popover)] min-w-[8rem] overflow-hidden rounded-overlay border border-border bg-popover p-1 text-popover-foreground shadow-md',
        'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        className,
      )}
      {...props}
    />
  );
}
