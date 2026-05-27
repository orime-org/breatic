import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * shadcn/ui Input — standard `<input>` styled with project tokens.
 *
 * Visual model (2026-05-25, PR #135 final): Input mirrors the
 * segmented-control cards' active/inactive border system in the same
 * dialog:
 *   - Default state  → `border-border` (light `--neutral-200`)
 *     same as an *unselected* type card. Low contrast, signals
 *     "not yet interacted with".
 *   - Focus state    → `border-active-border` (`--color-muted-foreground`,
 *     middle gray) — same as the *selected* type card. Border color
 *     changes; thickness stays 1 px (no ring layered on top).
 *
 * The previous design used `focus-visible:ring-1` which stacked an
 * extra 1 px outline on top of the border, visibly thickening the
 * input on focus (reported by user). Switched to a border-color
 * change only so width stays constant.
 *
 * Background: `bg-transparent` inherits the parent surface (popover /
 * dialog / chrome). `shadow-sm` from the shadcn vendor default was
 * dropped — chrome-flat is the project standard.
 *
 * Pass through all native `<input>` props. Use with `<Label>` for a11y.
 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-chrome border border-border bg-transparent px-3 py-1 text-base transition-colors',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
          'placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:border-active-border',
          'aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'md:text-sm',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
