import type { ComponentProps, ReactNode } from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';

import { cn } from '@web/lib/utils';

/**
 * Checkbox — 16px square (chrome radius). Checked = pure-black `bg-primary`
 * (mirrors the primary button); unchecked = a `border-muted-foreground` box
 * that darkens to the neutral ring on hover. Neutral 1px focus ring (no glow).
 * Built on Radix so keyboard / form semantics are handled for us.
 *
 * Unchecked, that border is the whole of what says the control is there — the
 * fill sits at 1.03:1 against the panel behind it — so it is held to WCAG
 * 1.4.11's 3:1. `border-border` measured 1.26:1 in light and 1.39:1 in dark.
 * `muted-foreground` measures 5.6:1 and 5.75:1 in light, 5.76:1 and 5.51:1 in
 * dark, against its own fill and against the dialog behind it.
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
        'peer inline-flex size-4 shrink-0 items-center justify-center rounded-chrome border border-muted-foreground bg-background transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
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
