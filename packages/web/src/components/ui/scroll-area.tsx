import * as React from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';

import { cn } from '@web/lib/utils';

/**
 * shadcn/ui ScrollArea — custom-styled scrollable region with consistent
 * cross-browser scrollbar appearance, backed by @radix-ui/react-scroll-area.
 *
 * Wrap content in `<ScrollArea>` and size it (e.g. `h-72 w-full`); Radix
 * positions a virtual scrollbar that matches the design system instead of
 * relying on native browser chrome (which differs Mac vs Windows vs Linux).
 *
 * Vendor deviation (#1773, user-ratified 2026-07-14): every visible scroller
 * in the app uses this primitive because the required scrollbar behaviour —
 * appears only while scrolling, takes no layout space, and hover changes
 * COLOR only (never shape) — is impossible with native scrollbars (macOS
 * overlay scrollbars widen with a track on hover; webkit scrollbar
 * pseudo-element painting forces an always-visible space-consuming classic
 * bar). `type` therefore defaults to `scroll` (Radix shows the bar while
 * scrolling and keeps it while the pointer rests on it).
 *
 * `viewportClassName` styles the Radix Viewport (the element that actually
 * scrolls) — put content padding there so it scrolls with the content.
 */
const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
    viewportClassName?: string;
  }
>(({ className, viewportClassName, children, type = 'scroll', ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    type={type}
    className={cn('relative overflow-hidden', className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport
      className={cn('h-full w-full rounded-[inherit]', viewportClassName)}
    >
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

/**
 * The overlay scrollbar: a fixed-width rail whose thumb brightens on hover —
 * color is the ONLY hover response; width and shape never change (#1773).
 */
const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = 'vertical', ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    // Scrollbar interaction must never move focus (native scrollbars don't):
    // preventing mousedown's default keeps focus where it is — critical for
    // scrollers whose focused child commits on blur (TextNode contenteditable)
    // — while Radix's pointer-event dragging is unaffected.
    onMouseDown={(e) => e.preventDefault()}
    className={cn(
      // Fade in on appear / fade out on hide, like the native overlay
      // scrollbar this replaces (#1773). Radix stamps data-state and its
      // Presence keeps the bar mounted until the exit animation finishes.
      'flex touch-none select-none p-px data-[state=hidden]:animate-out data-[state=hidden]:fade-out-0 data-[state=hidden]:duration-300 data-[state=visible]:animate-in data-[state=visible]:fade-in-0 data-[state=visible]:duration-150',
      orientation === 'vertical' && 'h-full w-2',
      orientation === 'horizontal' && 'h-2 flex-col',
      className,
    )}
    {...props}
  >
    {/* Hover response is opacity-only (40% → 60%): the sanctioned hover
        pattern (inner ADR 2026-05-21) AND the #1773 mandate that hover
        changes color, never shape. */}
    <ScrollAreaPrimitive.ScrollAreaThumb className='relative flex-1 rounded-full bg-muted-foreground opacity-40 transition-opacity hover:opacity-60' />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
