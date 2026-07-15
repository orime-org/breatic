import * as React from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';

import { cn } from '@web/lib/utils';

/**
 * ScrollArea — THE app-wide Scroller component (#1773, user-ratified
 * 2026-07-15): every visible scroller, vertical AND horizontal, goes through
 * this wrapper. It is our component; the Radix scroll-area primitive is only
 * the engine underneath (thumb dragging via pointer capture, touch, RTL,
 * axis geometry — wheels not worth reinventing).
 *
 * Behaviour contract (all of it OURS, none of it browser-dependent — CSS
 * Scrollbars L1 standardizes only thickness + two static colors; native
 * hover geometry/shading is UA-private and varies between browser builds):
 *   - the bar appears only while scrolling and while the pointer rests on it
 *     (`type` defaults to `scroll`), fading in/out;
 *   - it overlays content — zero layout space;
 *   - hover changes COLOR only (thumb opacity 40% → 60%), never shape;
 *   - scrollbar interaction NEVER disturbs input state: no focus move, no
 *     selection change, no IME interruption (see ScrollBar's mousedown
 *     handling below).
 *
 * `scrollbars` picks the axes ('vertical' default · 'horizontal' · 'both');
 * `viewportClassName` styles the Radix Viewport — the element that actually
 * scrolls — so content padding and height caps belong there.
 *
 * Layout traps (Radix internals): the viewport wraps children in an
 * auto-height `display:table` div. Two consequences and their fixes:
 *   - percentage heights (`h-full` centering) inside the viewport resolve
 *     to auto and collapse — keep centered empty/loading states OUTSIDE the
 *     ScrollArea (see StudioRecentPage) or give them explicit heights;
 *   - a table sizes to its content, so the width-constraint chain that
 *     `truncate` depends on breaks. For vertical-only scrollers the wrapper
 *     is forced back to `display:block` via the `data-scrollbars` stamp +
 *     an index.css rule (horizontal/both keep `table` — Radix uses it so
 *     content can exceed the viewport for horizontal scrolling).
 */
const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
    viewportClassName?: string;
    scrollbars?: 'vertical' | 'horizontal' | 'both';
  }
>(
  (
    { className, viewportClassName, children, type = 'scroll', scrollbars = 'vertical', ...props },
    ref,
  ) => (
    <ScrollAreaPrimitive.Root
      ref={ref}
      type={type}
      data-scrollbars={scrollbars}
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        className={cn('h-full w-full rounded-[inherit]', viewportClassName)}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {scrollbars !== 'horizontal' ? <ScrollBar orientation='vertical' /> : null}
      {scrollbars !== 'vertical' ? <ScrollBar orientation='horizontal' /> : null}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  ),
);
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

/**
 * The overlay scrollbar: a fixed-thickness rail whose thumb brightens on
 * hover — color is the ONLY hover response; width and shape never change
 * (#1773).
 */
const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = 'vertical', onMouseDown, ...props }, ref) => {
  /**
   * Input-state contract (user-ratified 2026-07-15): interacting with a
   * scrollbar must never move focus, collapse a selection, or interrupt an
   * IME composition — exactly like a native scrollbar. Focus/selection
   * changes are mousedown's DEFAULT action, so preventing it keeps the
   * focused input/textarea/contenteditable untouched while Radix's
   * pointer-event thumb dragging works normally. The contract is
   * non-negotiable: a caller-supplied onMouseDown is chained AFTER it and
   * cannot remove the preventDefault.
   * @param e - The mousedown event on the scrollbar rail.
   */
  const guardInputState = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    onMouseDown?.(e);
  };
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      ref={ref}
      orientation={orientation}
      {...props}
      onMouseDown={guardInputState}
      className={cn(
        // Fade in on appear / fade out on hide, like the native overlay
        // scrollbar this replaces (#1773). Radix stamps data-state and its
        // Presence keeps the bar mounted until the exit animation finishes.
        'flex touch-none select-none p-px data-[state=hidden]:animate-out data-[state=hidden]:fade-out-0 data-[state=hidden]:duration-300 data-[state=visible]:animate-in data-[state=visible]:fade-in-0 data-[state=visible]:duration-150',
        orientation === 'vertical' && 'h-full w-2',
        orientation === 'horizontal' && 'h-2 flex-col',
        className,
      )}
    >
      {/* Hover response is opacity-only (40% → 60%): the sanctioned hover
          pattern (inner ADR 2026-05-21) AND the #1773 mandate that hover
          changes color, never shape. forceMount is behaviour-neutral — the
          RAIL already gates all visibility (scroll activity + scrollability)
          — and lets jsdom tests pin this thumb contract (Radix otherwise
          skips the thumb when layout sizes are 0). */}
      <ScrollAreaPrimitive.ScrollAreaThumb
        forceMount
        className='relative flex-1 rounded-full bg-muted-foreground opacity-40 transition-opacity hover:opacity-60'
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
});
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
