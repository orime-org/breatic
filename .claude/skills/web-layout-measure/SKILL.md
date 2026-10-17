---
name: web-layout-measure
description: Use before writing flex, truncation or scroll layouts in packages/web, sizing a popover, sheet or dialog, measuring element geometry (getBoundingClientRect, offset*, elementFromPoint, ResizeObserver), scrolling a container from code, reacting to scroll events, or comparing a measured or derived value against a threshold.
---

# Layout, scrolling and measurement (packages/web)

The package rules (every visible scroller is `ScrollArea`, scroll a container with `scrollTo`, dialog height has two layers) are in `packages/web/AGENTS.md#every-scroller-is-a-scrollarea`. This skill holds the traps behind them.

## Scroll containers

- **Read the TSDoc at the top of `src/components/ui/scroll-area.tsx` before putting a `ScrollArea` inside a flex or grid parent.** It documents the three layout traps of Radix's `display:table` viewport wrapper: `h-full` centring inside the viewport collapses (keep centred empty/loading states outside, as `StudioRecentPage` does), a `flex-1` Root only scrolls while its column has a definite height (a column capped only by `max-height` clips instead; give the parent `grid-rows-[auto_minmax(0,1fr)]`, as `features/membership/MembershipPanel.tsx` does), and content padding and height caps go on `viewportClassName`.
- **Native scrollbar styling cannot give a consistent look, which is why `ScrollArea` exists.** `scrollbar-width` disables `::-webkit-scrollbar` in Chromium, so stacking both is dead code; Safari's overlay thumb colour follows `color-scheme` (declared per theme in `tokens.css`); native hover widening and colour are UA-private, so one browser build's probe does not generalise; headless WebKit draws no overlay bar, so check scrollbar colour in a real browser.
- **`ScrollArea`'s thumb drag is our own code because Radix's drag jumps under a CSS-transformed ancestor such as the zoomed canvas.** It converts pointer distance by the measured ambient scale; keep that when editing the component.
- **To get the element that scrolls, ask `ScrollArea` for it through `viewportRef`.** Do not plant a sentinel and walk up with `closest()`: Radix's wrapper structure is not our contract.
- **`scrollIntoView` moves every scrolling ancestor up to the document, and `block`/`inline: 'nearest'` only minimises each one's distance, it does not limit how many move.** On the project page the outer horizontal `ScrollArea` and, below the minimum window width, the page itself are both ancestors, so revealing a tab drags the whole page. Compute the offset from the container's and target's rects and call `scroller.scrollTo({ left, behavior })` (`scrollTabToEdge` in `SpaceTabBar.tsx`). The one exemption is the keyboard follow in `features/reference-mention/mention-list.tsx`, whose only scrolling ancestor is its own popover viewport; the exemption ends the moment it is placed inside another scroller. ProseMirror's `tr.scrollIntoView()` is a transaction method, not this DOM API.
- **"Can scroll further" state must use the same yardstick as the code that performs the scroll.** Derive `atStart`/`atEnd` from the same rect spans the step function searches (as `SpaceTabBar.tsx` does), never from `scrollLeft <= 0`: a smooth `scrollIntoView({ inline: 'start' })` ends at the scroller's `padding-left`, not at 0.
- **Code that shrinks an element to measure it must save and restore every ancestor's non-zero `scrollTop`.** The shrink is a real layout: ancestors clamp their scroll position and writing the height back does not restore it, which undoes the scroll the browser just made to the caret. Set `scroll-behavior: auto` while restoring. `src/lib/use-autosize-textarea.ts` does this (the `cacheScrollTops` idea from autosize).
- **A `scroll` event is not proof the reader moved: when content gets shorter the browser clamps `scrollTop` and fires `scroll` by itself.** To detect "the reader went toward the end", accept only an increasing `scrollTop` (relevant to `src/lib/use-scrolled-to-end.ts` and its callers).
  Check: is something changing the content height at the same moment as this `scroll` event?
- **`html, body { overscroll-behavior: none }` in `src/index.css` is deliberate.** Canvas and document spaces must not bounce or swipe-navigate; do not override it.

## Flex, truncation and text

- **A chrome bar inside a `flex-col` needs `shrink-0`**, otherwise flex shrinking squeezes it below its set height.
- **`truncate` on an inline element (`span`, `a`) clips visually but keeps the full content width in layout; add `inline-block min-w-0` and a max width.** A `contenteditable` span still draws its caret outside the clipped box while typing, so the editing state needs its own styling rather than the truncated display one.
- **Do not combine `leading-none` with `truncate`**: the line box equals the font size and `overflow:hidden` cuts descenders; use `leading-normal`.
- **A `w-max` popover is widened by a `<video>`'s intrinsic width once it loads and by text that grows with the selection.** Take the video out of flow (`absolute inset-0`) and give growing text `w-0 flex-1` so it wraps within the row.
- **Under `border-collapse` the browser ignores `border-radius` on table cells; use `border-separate border-spacing-0`** (as `features/membership/TierComparison.tsx` does). Only measuring the rendered table reveals it; the class is present either way.

## Overlay and dialog sizing

- **Overlays anchored to the chrome sit 4px below the chrome row and 4px from the screen edge.** A popover from a full-height chrome button (`--btn-chrome`, 32px in a 40px row) gets this from `PopoverContent`'s default `sideOffset={8}`; a shorter trigger needs a larger `sideOffset` so the popover top still lands 4px below the row. Floating sheets use `side='right-floating'` or `'left-floating'` from `components/ui/sheet.tsx`; do not override their top/inset with classes.
- **Size a modal from its content density, not from a habitual desktop width.** Measure the longest row, add the horizontal padding and about 10%; `components/ui/dialog.tsx` defaults to `max-w-[520px]`, which fits a short form plus a member list.

## Measuring geometry

- **After giving an element a hit area, verify it receives the pointer with `document.elementFromPoint` pixel by pixel; the pseudo-element's computed geometry does not prove it.** A stacking context can cover half the area: a `position:relative; z-index:auto` handle under `.react-flow__pane` (`z-index:1`) loses every pixel the pane overlaps.
  Check: did I measure the hit area's size, or whether it actually receives the pointer?
- **The measurement and the signal that triggers re-measurement must use the same coordinate semantics.** `getBoundingClientRect` includes transforms; `ResizeObserver` and `offsetWidth/Height/Left/Top` are layout-only. Overlay open animations (`zoom-in-95`) make a rect read during the animation about 5% small, and `ResizeObserver` never fires when the animation ends. Measure with `offset*` (as `ImageCropDialog.tsx` does), and when the box changes, rescale any existing selection proportionally. Converting pointer `clientX/Y` into element coordinates is the exception: use the rect there, because client coordinates already include the transform.
- **A value derived from a threshold and then multiplied and divided can land one ulp below that threshold, so compare it with a relative tolerance: `>= MIN * (1 - 1e-9)`.** `src/lib/crop-math.ts` (`NATURAL_CROP_REL_TOL`) does this; `1e-9` is the default `rel_tol` of Python's `math.isclose` ([PEP 485](https://peps.python.org/pep-0485/), read it when picking a different tolerance).
  Check: is this input something I reverse-solved from the same threshold and then passed through a multiply/divide?
- **Wait for an overlay's open animation before measuring it in a browser probe.** The `waitForFunction` that waits for the identity transform is in the smoke-test skill's [browser traps](../smoke-e2e/browser-traps.md#timing) (invoke `/smoke-e2e`).
