import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';

import { cn } from '@web/lib/utils';

/**
 * shadcn/ui Popover — accessible click-triggered floating panel backed by
 * @radix-ui/react-popover.
 *
 * Composition:
 *   <Popover>
 *     <PopoverTrigger asChild><Button>Open</Button></PopoverTrigger>
 *     <PopoverContent>...rich content...</PopoverContent>
 *   </Popover>
 *
 * Differences vs `Tooltip`:
 *   - Click (not hover) to open
 *   - Larger surface, intended for rich content / forms / lists
 *   - Manages focus inside; closes on outside click / Escape
 *
 * Renders content in a portal. Default `align="center"`, `sideOffset={4}`.
 */
const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

/**
 * What the content positions against, when the trigger is the wrong thing to
 * measure from.
 *
 * Without one, Radix anchors to the trigger. That is right whenever the
 * trigger stays where it is; a trigger living inside something that comes and
 * goes takes the anchor with it, and a detached element measures as zero.
 */
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 8, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 w-72 rounded-overlay border border-border bg-popover p-4 text-popover-foreground shadow outline-none',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
