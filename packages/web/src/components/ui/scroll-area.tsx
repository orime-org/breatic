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
 *   - the bar appears while scrolling AND when the pointer hovers its rail
 *     zone (user-ratified 2026-07-15: hover must reveal a hidden bar without
 *     scrolling first), fading in/out; the rails are force-mounted so the
 *     hover zone exists while hidden, and each rail carries its own axis's
 *     scrollability (`data-scrollable`, ResizeObserver-maintained) and turns
 *     its pointer-events off when that axis has nothing to scroll — no
 *     phantom reveals, no swallowed clicks on non-scrollable edges, and a
 *     scroller nested in another one is unaffected by its host's verdict;
 *   - it overlays content — zero layout space;
 *   - hover changes COLOR only (thumb opacity 40% → 60%) and the pointer is
 *     the default arrow (native scrollbar convention — never the text/grab
 *     cursor of the surroundings); shape never changes;
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
/**
 * Hand one node to a local ref and to whoever else asked for it.
 *
 * Both elements this file hands out need their node in two places at once: the
 * component keeps one to measure and drive, and a caller may have asked for
 * the same node.
 *
 * The callback is memoised because React detaches and re-attaches a ref whose
 * identity changed, calling the old one with `null` first. Radix composes the
 * viewport ref with a state setter of its own, so an unstable callback there
 * runs that setter to `null` and back on every single render of every scroller
 * in the app.
 * @param local - The ref this component reads.
 * @param forwarded - The ref a caller passed in, if any.
 * @returns A ref callback that feeds both, stable while `forwarded` is.
 */
function useKeepBoth<T>(
  local: React.MutableRefObject<T | null>,
  forwarded: React.Ref<T> | undefined,
): (node: T | null) => void {
  return React.useCallback(
    (node: T | null) => {
      local.current = node;
      if (typeof forwarded === 'function') forwarded(node);
      else if (forwarded) (forwarded as React.MutableRefObject<T | null>).current = node;
    },
    [local, forwarded],
  );
}

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
    viewportClassName?: string;
    scrollbars?: 'vertical' | 'horizontal' | 'both';
    /**
     * The element that actually scrolls, for a caller that has to drive it.
     * The Root this component forwards `ref` to is the box around it — reading
     * `scrollLeft` or calling `scrollBy` there does nothing.
     */
    viewportRef?: React.Ref<HTMLDivElement>;
  }
>(
  (
    {
      className,
      viewportClassName,
      children,
      type = 'scroll',
      scrollbars = 'vertical',
      viewportRef: forwardedViewportRef,
      ...props
    },
    ref,
  ) => {
    const viewportRef = React.useRef<HTMLDivElement>(null);
    const setViewportRef = useKeepBoth(viewportRef, forwardedViewportRef);
    const [scrollable, setScrollable] = React.useState({ x: false, y: false });
    React.useEffect(() => {
      const viewport = viewportRef.current;
      if (!viewport || typeof ResizeObserver !== 'function') return undefined;
      /**
       * Re-measures per-axis scrollability (drives the rails' hover-zone
       * gating). State identity is kept when nothing changed so the effect
       * never causes render churn.
       */
      const measure = (): void => {
        setScrollable((prev) => {
          const next = {
            x: viewport.scrollWidth > viewport.clientWidth + 1,
            y: viewport.scrollHeight > viewport.clientHeight + 1,
          };
          return next.x === prev.x && next.y === prev.y ? prev : next;
        });
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(viewport);
      // Radix's content wrapper resizes when content grows/shrinks even
      // while the viewport box stays fixed (e.g. typing into a capped
      // editor) — observe it too so the gate opens the moment content
      // becomes scrollable.
      if (viewport.firstElementChild) ro.observe(viewport.firstElementChild);
      return () => ro.disconnect();
    }, []);
    return (
      <ScrollAreaPrimitive.Root
        ref={ref}
        type={type}
        data-scrollbars={scrollbars}
        className={cn('relative overflow-hidden', className)}
        {...props}
      >
        <ScrollAreaPrimitive.Viewport
          ref={setViewportRef}
          className={cn('h-full w-full rounded-[inherit]', viewportClassName)}
        >
          {children}
        </ScrollAreaPrimitive.Viewport>
        {scrollbars !== 'horizontal' ? (
          <ScrollBar forceMount orientation='vertical' scrollable={scrollable.y} />
        ) : null}
        {scrollbars !== 'vertical' ? (
          <ScrollBar forceMount orientation='horizontal' scrollable={scrollable.x} />
        ) : null}
        <ScrollAreaPrimitive.Corner />
      </ScrollAreaPrimitive.Root>
    );
  },
);
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

/**
 * The overlay scrollbar: a fixed-thickness rail whose thumb brightens on
 * hover — color is the ONLY hover response; width and shape never change
 * (#1773).
 */
const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar> & {
    scrollable?: boolean;
  }
>(({ className, orientation = 'vertical', onMouseDown, scrollable = true, ...props }, ref) => {
  const railRef = React.useRef<HTMLDivElement | null>(null);
  const setRailRef = useKeepBoth(railRef, ref);
  /**
   * Input-state contract (user-ratified 2026-07-15): interacting with a
   * scrollbar must never move focus, collapse a selection, or interrupt an
   * IME composition — exactly like a native scrollbar. Focus/selection
   * changes are mousedown's DEFAULT action, so preventing it keeps the
   * focused input/textarea/contenteditable untouched. The contract is
   * non-negotiable: a caller-supplied onMouseDown is chained AFTER it and
   * cannot remove the preventDefault.
   * @param e - The mousedown event on the scrollbar rail.
   */
  const guardInputState = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    onMouseDown?.(e);
  };
  /**
   * Scale-aware drag takeover (#1773 round-5, user-reported jump). Radix's
   * own drag math mixes SCREEN-space pointer coordinates/rects with
   * LAYOUT-space sizes, so inside a CSS-transformed ancestor (ReactFlow's
   * zoomed canvas) pressing the thumb JUMPS the content and drag deltas are
   * mis-scaled (real-Chrome probe at zoom 0.58: press at thumb centre moved
   * scrollTop 60 → 34). This capture-phase handler stops Radix's handlers
   * (React synthetic stopPropagation in capture suppresses same-element
   * bubble listeners) and re-implements both gestures in pure LAYOUT space,
   * dividing pointer distances by the measured ambient scale:
   *   - thumb press → relative drag (press itself never moves content);
   *   - track press → jump-to-point (thumb centres at the pointer), then
   *     drag continues.
   * Pointer capture keeps the gesture on the rail; data-dragging keeps the
   * rail revealed while dragging even if the pointer strays off it.
   * @param e - The pointerdown event on the rail (capture phase).
   */
  const takeOverDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const rail = railRef.current;
    const root = rail?.closest('[data-scrollbars]');
    const viewport = root?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]');
    if (!rail || !viewport) return;
    const vertical = orientation === 'vertical';
    const thumb = rail.firstElementChild as HTMLElement | null;
    if (!thumb) return;
    const maxScroll = vertical
      ? viewport.scrollHeight - viewport.clientHeight
      : viewport.scrollWidth - viewport.clientWidth;
    const thumbSize = vertical ? thumb.offsetHeight : thumb.offsetWidth;
    // p-px padding on the rail: the thumb travels inside the content box.
    const trackRange = (vertical ? rail.clientHeight : rail.clientWidth) - 2 - thumbSize;
    if (maxScroll <= 0 || trackRange <= 0) return;
    e.stopPropagation();
    e.preventDefault();
    const railRect = rail.getBoundingClientRect();
    const railScreen = vertical ? railRect.height : railRect.width;
    const railLayout = vertical ? rail.offsetHeight : rail.offsetWidth;
    const scale = railLayout > 0 && railScreen > 0 ? railScreen / railLayout : 1;
    const pointer = vertical ? e.clientY : e.clientX;
    const thumbRect = thumb.getBoundingClientRect();
    const onThumb = vertical
      ? pointer >= thumbRect.top && pointer <= thumbRect.bottom
      : pointer >= thumbRect.left && pointer <= thumbRect.right;
    /**
     * Writes a clamped scroll position to the viewport axis.
     * @param next - Target scroll offset in layout px.
     * @returns The clamped value actually applied.
     */
    const setScroll = (next: number): number => {
      const clamped = Math.max(0, Math.min(maxScroll, next));
      if (vertical) viewport.scrollTop = clamped;
      else viewport.scrollLeft = clamped;
      return clamped;
    };
    let startScroll = vertical ? viewport.scrollTop : viewport.scrollLeft;
    if (!onThumb) {
      const pointerInRail = (pointer - (vertical ? railRect.top : railRect.left)) / scale;
      startScroll = setScroll(((pointerInRail - 1 - thumbSize / 2) / trackRange) * maxScroll);
    }
    const ratio = maxScroll / trackRange;
    rail.dataset.dragging = 'true';
    rail.setPointerCapture(e.pointerId);
    /**
     * Applies the scale-corrected relative drag on every captured move.
     * @param ev - A captured pointermove on the rail.
     */
    const onMove = (ev: PointerEvent): void => {
      const delta = ((vertical ? ev.clientY : ev.clientX) - pointer) / scale;
      setScroll(startScroll + delta * ratio);
    };
    /**
     * Ends the gesture: releases capture and detaches the listeners.
     * @param ev - The pointerup/pointercancel that ends the drag.
     */
    const end = (ev: PointerEvent): void => {
      delete rail.dataset.dragging;
      try {
        rail.releasePointerCapture(ev.pointerId);
      } catch {
        // capture already released (e.g. pointercancel) — nothing to undo
      }
      rail.removeEventListener('pointermove', onMove);
      rail.removeEventListener('pointerup', end);
      rail.removeEventListener('pointercancel', end);
    };
    rail.addEventListener('pointermove', onMove);
    rail.addEventListener('pointerup', end);
    rail.addEventListener('pointercancel', end);
  };
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      ref={setRailRef}
      orientation={orientation}
      {...props}
      data-scrollable={scrollable ? 'true' : 'false'}
      onMouseDown={guardInputState}
      onPointerDownCapture={takeOverDrag}
      className={cn(
        // Always-mounted rail, visibility by opacity TRANSITION (not
        // mount/unmount animation): hidden by default, revealed while
        // scrolling (Radix flips data-state) OR while the pointer hovers the
        // rail zone (user-ratified 2026-07-15) — 150ms in, 300ms out, like
        // the native overlay bar. cursor-default pins the native-scrollbar
        // arrow (otherwise the rail inherits the surroundings' text/grab
        // cursor). The gate turns pointer-events off when THIS rail's own
        // axis has nothing to scroll, so a non-scrollable rail can neither
        // hover-reveal nor swallow edge clicks. The verdict is stamped on
        // the rail because a `group-data-…/scroller:` variant compiles to a
        // plain descendant selector: once scrollers nest — a wide table
        // inside the message list — the outer one's answer about an axis it
        // never scrolls reaches the inner rail, and the bar there shows up
        // and cannot be grabbed.
        'group/rail flex touch-none select-none p-px cursor-default opacity-0 transition-opacity duration-300 hover:opacity-100 hover:duration-150 data-[state=visible]:opacity-100 data-[state=visible]:duration-150 data-[dragging=true]:opacity-100 data-[scrollable=false]:pointer-events-none',
        orientation === 'vertical' && 'h-full w-2',
        orientation === 'horizontal' && 'h-2 flex-col',
        className,
      )}
    >
      {/* Hover response is opacity-only (40% → 60%): the sanctioned hover
          pattern (ADR 2026-05-21) AND the #1773 mandate that hover
          changes color, never shape. An ACTIVE DRAG keeps the hover color
          via the rail's data-dragging stamp (user 2026-07-15) — during a
          captured drag the pointer routinely strays off the thumb, and
          losing :hover mid-drag read as a false release. forceMount is
          behaviour-neutral — the RAIL already gates all visibility (scroll
          activity + scrollability) — and lets jsdom tests pin this thumb
          contract (Radix otherwise skips the thumb when layout sizes are
          0). */}
      <ScrollAreaPrimitive.ScrollAreaThumb
        forceMount
        className='relative flex-1 rounded-full bg-muted-foreground opacity-40 transition-opacity hover:opacity-60 group-data-[dragging=true]/rail:opacity-60'
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
});
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
