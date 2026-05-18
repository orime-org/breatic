import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * shadcn/ui Label — accessible form label backed by @radix-ui/react-label.
 *
 * Wraps `LabelPrimitive.Root`. Radix forwards the native `<label>` semantics
 * and adds: clicking the label moves focus to the associated form control
 * (via `htmlFor`), and pointer-events filter to ignore disabled peers.
 *
 * Pairs with `peer-disabled:cursor-not-allowed` so a label next to a
 * disabled `<Input>` / `<Textarea>` greys out automatically.
 */
const labelVariants = cva(
  'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
);

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> &
    VariantProps<typeof labelVariants>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(labelVariants(), className)}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
