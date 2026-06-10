import type { ComponentProps, ReactNode } from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';

import { cn } from '@web/lib/utils';

/**
 * Checkbox — 16px square (chrome radius). Checked = pure-black `bg-primary`
 * (mirrors the primary button); unchecked = a hairline `border-input` box that
 * brightens to the neutral ring on hover. Neutral 1px focus ring (no glow).
 * Built on Radix so keyboard / form semantics are handled for us.
 * @param props - Radix Checkbox.Root props (controlled `checked` /
 *   `onCheckedChange`, `disabled`, `id`, …).
 * @returns An accessible checkbox control.
 */
export function Checkbox({
  className,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>): ReactNode {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'peer inline-flex size-4 shrink-0 items-center justify-center rounded-chrome border border-input bg-background transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className='flex items-center justify-center text-current'>
        <Check className='size-3' strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
