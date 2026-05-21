import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * shadcn/ui Input — standard `<input>` styled with project tokens.
 *
 * Tokens used (see `theme/shadcn-bridge.css`):
 *   - `border-input`        → border color
 *   - `bg-transparent`      → inherits parent background
 *   - `text-foreground`     → text color
 *   - `placeholder:text-muted-foreground`
 *   - `focus-visible:ring-ring` → focus ring (--ring)
 *   - `disabled:opacity-50`
 *
 * Pass through all native `<input>` props. Use with `<Label>` for a11y.
 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-chrome border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
          'placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
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
