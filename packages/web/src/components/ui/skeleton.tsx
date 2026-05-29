import * as React from 'react';

import { cn } from '@web/lib/utils';

/**
 * shadcn/ui Skeleton — loading placeholder block.
 *
 * Plain `<div>` with `animate-pulse` (Tailwind built-in keyframe) and a
 * 10% primary fill so the placeholder reads as "loading" without competing
 * for attention with real content.
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
    <div
      className={cn('animate-pulse rounded-md bg-primary/10', className)}
      {...props}
    />
  );
}

export { Skeleton };
