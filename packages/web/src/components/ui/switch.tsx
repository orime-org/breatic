import type { ComponentProps, ReactNode } from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';

import { cn } from '@web/lib/utils';

/**
 * Switch — a 36×20 pill. Off = `bg-input` gray, on = pure-black `bg-primary`
 * (white in dark mode, so the thumb flips contrast with it). The thumb is the
 * page surface with a hairline border + faint shadow so it stays visible
 * against every track state. Neutral 1px focus ring.
 * @param props - Radix Switch.Root props (controlled `checked` /
 *   `onCheckedChange`, `disabled`, `id`, …).
 * @returns An accessible toggle switch.
 */
export function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>): ReactNode {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent px-0.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=unchecked]:bg-input data-[state=checked]:bg-primary',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className='pointer-events-none block size-4 rounded-full border border-border bg-background shadow-sm transition-transform data-[state=unchecked]:translate-x-0 data-[state=checked]:translate-x-4' />
    </SwitchPrimitive.Root>
  );
}
