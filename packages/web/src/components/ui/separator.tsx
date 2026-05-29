import * as React from 'react';
import * as SeparatorPrimitive from '@radix-ui/react-separator';

import { cn } from '@web/lib/utils';

/**
 * shadcn/ui Separator — horizontal or vertical rule backed by
 * @radix-ui/react-separator.
 *
 * - `orientation="horizontal"` (default): 1px tall, full width
 * - `orientation="vertical"`: 1px wide, full height (parent must have height)
 * - `decorative` (default `true`) hides from the a11y tree; set to `false`
 *   when the separator carries semantic meaning (e.g. between toolbar groups
 *   that screen readers should announce as separate).
 *
 * Token: `bg-border` → `var(--border)` → `var(--neutral-200)`.
 */
const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(
  (
    { className, orientation = 'horizontal', decorative = true, ...props },
    ref,
  ) => (
    <SeparatorPrimitive.Root
      ref={ref}
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-[1px] w-full' : 'h-full w-[1px]',
        className,
      )}
      {...props}
    />
  ),
);
Separator.displayName = SeparatorPrimitive.Root.displayName;

export { Separator };
