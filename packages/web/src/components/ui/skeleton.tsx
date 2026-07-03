import * as React from 'react';

import { cn } from '@web/lib/utils';

/**
 * shadcn/ui Skeleton — loading placeholder block.
 *
 * Plain `<div>` with the `skeleton-shimmer` treatment (see `index.css`):
 * a foreground-mixed base fill plus a sweeping highlight, replacing the
 * old `animate-pulse bg-primary/10` whose 10%→5% opacity swing was
 * near-invisible against a card surface (#1550). Falls back to the static
 * fill under `prefers-reduced-motion`.
 *
 * Size with `className`: e.g. `<Skeleton className="h-4 w-full" />` for a
 * one-line text placeholder, `<Skeleton className="h-10 w-10 rounded-full" />`
 * for an avatar placeholder.
 *
 * Decorative — does NOT add `role="status"` or `aria-busy` automatically.
 * If announcing loading state to screen readers, wrap with `aria-live` /
 * `aria-busy` on the parent.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('skeleton-shimmer rounded-md', className)} {...props} />
  );
}

export { Skeleton };
