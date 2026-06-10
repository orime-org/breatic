import type { ComponentProps, ReactNode } from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';

import { cn } from '@web/lib/utils';

/**
 * Radio group container — a vertical stack of {@link RadioGroupItem}s.
 * @param props - Radix RadioGroup.Root props (controlled `value` /
 *   `onValueChange`, `name`, …).
 * @returns The radio group.
 */
export function RadioGroup({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Root>): ReactNode {
  return (
    <RadioGroupPrimitive.Root
      className={cn('flex flex-col gap-2.5', className)}
      {...props}
    />
  );
}

/**
 * Radio item — a 16px circle with a pure-black `bg-primary` inner dot when
 * selected (matches the checkbox checked state). Neutral 1px focus ring.
 * @param props - Radix RadioGroup.Item props (`value`, `disabled`, …).
 * @returns A single radio control.
 */
export function RadioGroupItem({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Item>): ReactNode {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-background transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className='flex items-center justify-center'>
        <span className='size-2 rounded-full bg-primary' />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}
