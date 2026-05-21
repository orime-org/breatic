import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * shadcn/ui Badge — compact rounded chip for status / count / category labels.
 *
 * Plain `<div>` (no Radix dependency); rendered inline-flex so it composes
 * with icons and short text.
 *
 * Variants (shadcn standard):
 *   - `default`     — primary token (high emphasis)
 *   - `secondary`   — secondary token (medium emphasis)
 *   - `destructive` — destructive token (deletion / error chips)
 *   - `outline`     — border-only (low emphasis)
 *
 * For project status colors (success / info / warning / error), use
 * `<StatusBadge>` (added in a later PR) rather than extending this primitive.
 */
const badgeVariants = cva(
  'inline-flex items-center rounded-chrome border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80',
        outline: 'text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
