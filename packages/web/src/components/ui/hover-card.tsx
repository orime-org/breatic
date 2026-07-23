import * as React from 'react';
import * as HoverCardPrimitive from '@radix-ui/react-hover-card';

import { cn } from '@web/lib/utils';

/**
 * shadcn/ui HoverCard — a hover-triggered floating panel backed by
 * @radix-ui/react-hover-card.
 *
 * Differences vs the other floats:
 *   - vs `Tooltip`: can host INTERACTIVE content (the playable media
 *     preview's play / seek), and has no shared provider — open/close
 *     timing is per-instance via `openDelay` / `closeDelay` on the Root.
 *   - vs `Popover`: opens on HOVER, not click.
 *
 * Renders content in a portal (like `Popover`) so it escapes container
 * `overflow` clipping and ancestor CSS transforms. Note: a modal Dialog /
 * Sheet sets `pointer-events: none` on the body, which the portaled
 * content inherits — a consumer that must stay clickable inside a modal
 * container re-enables it with `pointer-events: auto` on the content (see
 * `HoverPreview`).
 */
const HoverCard = HoverCardPrimitive.Root;

const HoverCardTrigger = HoverCardPrimitive.Trigger;

const HoverCardContent = React.forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  <HoverCardPrimitive.Portal>
    <HoverCardPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded-content-sm border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  </HoverCardPrimitive.Portal>
));
HoverCardContent.displayName = HoverCardPrimitive.Content.displayName;

export { HoverCard, HoverCardTrigger, HoverCardContent };
