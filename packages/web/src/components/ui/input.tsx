import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * shadcn/ui Input — standard `<input>` styled with project tokens.
 *
 * Tokens used (see `theme/shadcn-bridge.css`):
 *   - `border-active-border` → border color (2026-05-25, PR #135):
 *     unified with NewSpaceDialog selected card border + ChatComposer
 *     focus-within border so any "focus / interaction surface" inside
 *     the chrome reads at the same neutral middle-gray
 *     (`--color-muted-foreground`). Replaces the prior `border-input`
 *     (light `--neutral-200`) which created a two-tone mismatch with
 *     selected segmented-control cards in the same dialog.
 *   - `bg-transparent`      → inherits parent background
 *   - `text-foreground`     → text color
 *   - `placeholder:text-muted-foreground`
 *   - `focus-visible:ring-active-border` → focus ring (same token as
 *     border; ring layered on top adds a 1px keyboard-focus halo)
 *   - `disabled:opacity-50`
 *
 * The `shadow-sm` (a faint inset shadow shipping with shadcn vendor
 * default) was dropped 2026-05-25 — visually it darkened the input
 * edge, breaking visual parity with sibling unselected segmented-
 * control cards (which carry no shadow). Chrome-flat is the project
 * standard.
 *
 * Pass through all native `<input>` props. Use with `<Label>` for a11y.
 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-chrome border border-active-border bg-transparent px-3 py-1 text-base transition-colors',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
          'placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-active-border',
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
