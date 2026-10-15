---
name: radix-shadcn
description: Use before building or changing anything in `packages/web/src/components/ui/` or any Radix/shadcn overlay in packages/web (tooltip, popover, hover card, dialog, sheet, dropdown menu, sonner toast), before handling focus moves around overlays, before switching a hand-styled button to a `Button` variant, and before evaluating a third-party UI library for adoption.
---

# Radix and shadcn primitives (packages/web)

`components/ui/` is vendored shadcn code built on Radix and styled with Tailwind. The package rules (only one `TooltipProvider`, overlays on the canvas follow the viewport, one hover overlay per element, `Button` only) are in `packages/web/AGENTS.md`.

## Vendor defaults

- **When a vendor primitive's default style conflicts with the approved design mock, edit the vendor file in `components/ui/`; token naming follows ADR 14.** A shadcn default (`rounded-md`, `hover:bg-X/90`, a bare `border`) is a starter-template convention, not the design system; changing it at the primitive fixes every caller at once.
- **A default changed on one primitive must not be copied to a sibling without checking the sibling's semantics.** `Sheet` is non-modal by default (side panel, chrome stays clickable) while `Dialog` is modal (backdrop, scroll lock, focus trap); copying the Sheet default onto Dialog breaks every real dialog.
- **Interaction rings use `focus-visible:`, never `focus:`.** `focus:` also shows the ring after a mouse click.

## Tooltips and hover cards

- **`TooltipContent` renders inline unless it gets `portal`.** Pass `portal` in two cases only: the trigger sits inside a CSS-transformed ancestor (the canvas), or inside a clipping scroll container (e.g. `pages/project/chat/SpaceContextChip.tsx`, whose card would cut the tooltip off). The TSDoc in `components/ui/tooltip.tsx` says the same.
- **An inline tooltip inherits every ancestor's opacity, and an `img`'s computed `opacity` stays 1 even when an ancestor fades it.** Reading the image's opacity therefore cannot explain why two previews look different; walk the ancestor chain. To show something as unavailable, set the opacity on that element itself (for a preview, on the image), not on a wrapper that also contains the inline tooltip, which would make the whole tooltip see-through.
- **`HoverCard` content portals to `body`, and an open modal sets `pointer-events:none` on `body`, so give the content `pointer-events: auto`** (as `spaces/canvas/nodes/_shared/HoverPreview.tsx` does). CDP-synthesised clicks skip real hit-testing and give false results here in both directions; check with `document.elementFromPoint` or a real pointer.
  Check: can this portalled overlay open while a modal is up?
- **Focus handed back to a button opens its tooltip or hover card at once, ignoring `delayDuration`.** That happens when an overlay closes and Radix returns focus to its trigger, and whenever app code calls `.focus()` on the button (e.g. the canvas returning focus to a pick trigger when a pick ends). Put `onFocusCapture={suppressTooltipFocusOpen}` (`src/lib/overlay-focus.ts`) on the trigger and leave the overlay's `onCloseAutoFocus` alone so focus still returns. Calling `preventDefault` in `onCloseAutoFocus` is valid only if you then focus a correct target yourself (`useReturnFocus` in the same file); never let focus fall to `body`.
  Check: does anything focus this button programmatically? If yes, the suppressor stays.
- **Radix keeps tooltip content mounted for about 150ms after `open` turns false to play the exit animation.** Content computed as `open ? resolve() : undefined` renders an empty box during the fade; keep the resolved value in state, seeded on mount, refreshed on open and not cleared on close. jsdom runs no animation, so only a real browser shows it.

## Popovers, menus and dialogs

- **A popover trigger's hover and active effects may use only paint properties (`opacity`, `color`, `border-color`, `box-shadow`).** `transform: scale` and anything else that changes the trigger's rect makes floating-ui re-anchor, and the popover jumps when the pointer leaves. `spaces/canvas/empty-image/__tests__/EmptyImageColorPicker.test.tsx` pins the absence of `scale`.
- **Radix moves focus to the first focusable element when a popover opens, and `:focus-visible` cannot tell that from a reader's keyboard move.** Chrome also matches `:focus-visible` after a keyboard open or after Escape. Focus the popover itself instead: `onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).focus(); }}` (as `spaces/canvas/generate/CameraCommandPicker.tsx` does), after which any focused option was reached by the reader. jsdom reports `:focus-visible` as false for scripted focus, so unit tests do not catch it.
- **Reset an overlay's transient state in `onOpenChange(true)`, not on close.** During the ~150ms close animation the content still receives `pointerenter` and clicks, which would write the state back into the next opening.
- **A `DropdownMenu` item that opens an inline editor must defer the open to `DropdownMenuContent`'s `onCloseAutoFocus`.** During the menu's exit animation its focus scope still traps focus, so focusing the editor from `onSelect` ends on `body`. Set a ref flag in `onSelect`, and in `onCloseAutoFocus` call `preventDefault()` and open the editor only when the flag is set, so Escape and outside clicks still behave normally (`spaces/canvas/NodeContextMenu.tsx`).

## Sonner toasts

- **Change toast width through the `--width` CSS variable on the Toaster, not with classes.** Sonner's `[data-sonner-toaster]` and `[data-sonner-toast]` rules set `width: var(--width)` and out-rank Tailwind classes. Use `max-content`: `fit-content` inside sonner's nested flex collapses CJK text to one character per line.
- **Override sonner-controlled visuals (background, colour, border colour, padding, min height) with `toastOptions.style`, not `classNames`.** Sonner's `[data-sonner-toast][data-styled=true]` rule beats a single class regardless of order; only inline style wins. `components/ui/sonner.tsx` already does both.

## Switching to a Button variant

- **Before replacing hand-written classes with a `Button` variant, prove they are the same: compare them against `buttonVariants`' base plus the target variant, then compare both versions' computed styles in a real browser.** Zero difference means it is a rewrite; any difference means the change alters the look and must be treated as a visual change.

## Evaluating a third-party UI library

A library can be adopted only if every visible part of it can be restyled into ours and it coexists with Radix and shadcn (the admission rule is in `packages/web/AGENTS.md`). Our UI has three layers, and each is checked on its own:

| Layer | Ours | The library must | How to check |
|---|---|---|---|
| Tailwind | Tailwind 4; tokens in `src/theme/tokens.css` `@theme` | style through classes we can override; CSS-in-JS at runtime, a shipped stylesheet or hard-coded inline values each need a separate check that we can override them | read its component source for classes versus `style`; read what its own CSS file covers |
| shadcn | `src/components/ui/`, colours only through semantic tokens (repo-lint `no-brand-usage`) | land its colours on our `--color-*` tokens so both themes follow; hard-coded colours or a private palette must be replaceable | list every colour class in its source and check each against `tokens.css` |
| Radix | the `@radix-ui/*` packages in `packages/web/package.json` | not build its own overlays, focus management, portals or scroll lock (they fight Radix's focus stack); its own inputs and buttons must not diverge from `components/ui/` | count every overlay-type element it renders and when each appears |

Check: can we override how it styles? Do its colours land on our tokens? Does its behaviour compete with Radix? One "no" rules it out.

The check counts only when you have read its component source, listed everything it renders, where each one's style comes from, and its replacement hooks (`components` map, `className`, CSS variables, `prefix`). No replacement hook means it cannot be adapted; record that as the exclusion reason in the DD document.
