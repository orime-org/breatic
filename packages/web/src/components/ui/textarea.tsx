import * as React from 'react';

import { cn } from '@web/lib/utils';

/**
 * shadcn/ui Textarea — multi-line text input styled with project tokens.
 *
 * Same token contract as `Input`. Default min height 60px (1.5rem × ~3 lines);
 * the `min-h-*` class can be overridden via `className`. Vertical resize
 * stays at the browser default (`resize: vertical`); pass `resize-none` /
 * `resize-y` etc. through `className` to override.
 *
 * Pair with `<Label>` for accessible labeling.
 */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<'textarea'>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        'flex min-h-[60px] w-full rounded-chrome border border-border bg-transparent px-3 py-2 text-base',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:border-active-border',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'md:text-sm',
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = 'Textarea';

export { Textarea };
