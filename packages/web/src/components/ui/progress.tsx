import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';

import { cn } from '@web/lib/utils';

/**
 * shadcn/ui Progress — a 4px rounded bar backed by @radix-ui/react-progress.
 *
 * - `value` 0–100 fills that share of the track; `null` shows indeterminate
 *   progress (a band sliding across, `progress-indeterminate` in `index.css`).
 * - `indicatorClassName` changes the fill colour (default `bg-foreground`).
 *
 * Tokens: track `bg-muted`, fill `bg-foreground`.
 */
const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }
>(({ className, value, indicatorClassName, ...props }, ref) => {
  const known = typeof value === 'number';
  return (
    <ProgressPrimitive.Root
      ref={ref}
      value={value}
      className={cn('relative h-1 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn('h-full bg-foreground', known ? 'w-full' : 'progress-indeterminate', indicatorClassName)}
        style={known ? { transform: `translateX(-${100 - value}%)` } : undefined}
      />
    </ProgressPrimitive.Root>
  );
});
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
