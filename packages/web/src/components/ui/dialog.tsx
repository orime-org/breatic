import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { cn } from '@web/lib/utils';

/**
 * shadcn/ui Dialog — modal dialog backed by @radix-ui/react-dialog.
 *
 * Use for non-destructive modals (forms / settings / wizards). For
 * irreversible / destructive confirmations use `AlertDialog` instead.
 *
 * Layout convention (per chrome-baseline `.modal-dialog`):
 *   - container: 520 px max, 6 px radius, card bg, p-0 (sections own padding)
 *   - `<DialogHeader>` is a flex-row with title/desc stack on the left and an
 *     inline close X button on the right (matches mock `.modal-header`)
 *   - inner sections each pad themselves (mock `.modal-section` style)
 *   - `<DialogFooter>` aligns buttons to the right
 */
/**
 * Project default (2026-05-25, corrected):
 *   - **Dialog is modal-by-default** — Radix `<Dialog.Root>` ships
 *     `modal=true` (backdrop + body scroll lock + focus trap) and
 *     `DialogContent` below always renders `<DialogOverlay />`. The
 *     half-transparent backdrop is non-negotiable for modal semantics.
 *   - **Sheet is non-modal-by-default** — see `components/ui/sheet.tsx`.
 * Use the global `useExclusiveOverlay(id)` hook so only one overlay is
 * visible at a time (independent of modal/non-modal).
 *
 * Earlier (PR #135 prior) Dialog defaulted to `modal=false` + no
 * overlay by mis-applying the Sheet rule. Reverted because the modal
 * dialog consumers (NewSpaceDialog / MembersModal) need modal semantics.
 */
const Dialog = (
  props: React.ComponentProps<typeof DialogPrimitive.Root>,
) => <DialogPrimitive.Root {...props} />;
Dialog.displayName = 'Dialog';

const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

/**
 * What both primitives' overlays are.
 *
 * `inset-0` is load-bearing twice over: it is what covers the screen, and it
 * is where the scroller's height comes from. The transition length has to
 * match the content's — the content unmounts with the overlay around it, so a
 * shorter one here cuts the content's exit short.
 */
const OVERLAY_CLASS =
  'fixed inset-0 z-50 bg-black/80 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0';

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(OVERLAY_CLASS, className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * The scroller that lets a modal taller than the viewport be reached.
 *
 * A modal has an intrinsic minimum size — the form rows, buttons and help text
 * of "New Space" cannot be squeezed below it — so capping its height would cut
 * content off instead of revealing it. The overlay scrolls the whole box
 * instead, which is what Radix's own docs, shadcn and the CSS working group
 * all land on. Height stays the modal's own business: one whose content has no
 * ceiling (a spend history of 500 rows) gives itself an inner scroll region;
 * one with a fixed handful of rows sets nothing and rides this scroller.
 *
 * `AlertDialog` renders the same thing, so the two class strings live here
 * once — the way `alert-dialog.tsx` already borrows `buttonVariants`.
 *
 * The gutter is the padding the header and footer already use. It comes out
 * of the width every modal has to work in, so it stays small.
 * @param props.children The modal content to centre and scroll.
 * @returns The overlay's scrolling viewport.
 */
const DialogOverlayScroller = ({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement => (
  <ScrollArea
    className='h-full w-full'
    viewportClassName='grid place-items-center p-4'
    // The thumb's usual ink is muted-foreground, which reads as "quiet ink on
    // one of our surfaces". This rail is on the backdrop instead, dark in both
    // themes, and that ink composites to 1.31:1 there in light and 1.92:1 in
    // dark — a bar the reader has to find, at a fraction of the contrast one
    // needs. White at the same opacity is the same bar, seen: 3.48:1 and
    // 3.75:1, measured off the painted pixels.
    thumbClassName='bg-white'
  >
    {children}
  </ScrollArea>
);
DialogOverlayScroller.displayName = 'DialogOverlayScroller';

/**
 * What both primitives' contents share. `relative` and `mx-auto` are the
 * contract: in flow so the overlay can scroll it, centred by margins because
 * Radix's wrapper fills the grid area. The transition length matches the
 * overlay's, which unmounts it.
 */
const OVERLAY_CONTENT_CLASS =
  'relative z-50 mx-auto w-full border border-border bg-card shadow duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95';

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay>
      <DialogOverlayScroller>
        <DialogPrimitive.Content
          ref={ref}
          // `mx-auto` centres horizontally, not `place-items-center`: Radix
          // wraps the viewport's children in a div carrying an inline
          // `min-width: 100%`, so that wrapper fills the grid area whatever
          // the grid says.
          className={cn(
            OVERLAY_CONTENT_CLASS,
            'flex max-w-[520px] flex-col rounded-overlay p-0',
            className,
          )}
          {...props}
          // The overlay's scrollbar rail sits outside the content and so
          // counts as "outside" — but it is the dialog's own bar. Only the
          // middle button arrives here: the rail claims the primary one for
          // its drag, and Radix vetoes the secondary one itself. Stopping the
          // press at the rail instead would keep it from the document, where
          // the dismissable layer clears the flag it set on the way down, and
          // cost the reader a second click on anything outside. Declared after
          // the spread so a caller's own handler cannot displace it, and
          // called from here so it still runs.
          onPointerDownOutside={(e) => {
            props.onPointerDownOutside?.(e);
            const target = e.detail.originalEvent.target;
            if (
              target instanceof Element &&
              target.closest('[data-scrollable]')
            ) {
              e.preventDefault();
            }
          }}
        >
          {children}
        </DialogPrimitive.Content>
      </DialogOverlayScroller>
    </DialogOverlay>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

interface DialogHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Hide the inline close button (rare — modal still closes on Escape / overlay click). */
  hideClose?: boolean;
}

/**
 * Dialog header — row layout with title/desc stack on the left and an
 * inline 32 px chrome close X button on the right (matches mock
 * `.modal-header`). Auto-pads `px-4 py-3` so the modal can stay `p-0`
 * at the container level and let each section own its padding.
 */
const DialogHeader = ({
  className,
  hideClose,
  children,
  ...props
}: DialogHeaderProps) => (
  <header
    className={cn(
      'flex items-start justify-between gap-4 border-b border-border px-4 py-3',
      className,
    )}
    {...props}
  >
    <div className='flex min-h-[var(--btn-chrome)] min-w-0 flex-col justify-center gap-1 text-left'>
      {children}
    </div>
    {hideClose ? null : (
      <DialogPrimitive.Close
        className='inline-flex h-[var(--btn-chrome)] w-[var(--btn-chrome)] shrink-0 items-center justify-center rounded-chrome text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none'
        aria-label='Close'
      >
        <X className='h-[18px] w-[18px]' />
      </DialogPrimitive.Close>
    )}
  </header>
);
DialogHeader.displayName = 'DialogHeader';

/**
 * Dialog footer — flex-row with right-aligned action buttons. Auto-pads
 * `px-4 py-3` mirroring the header.
 */
const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col-reverse gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-end',
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

/**
 * Dialog body — generic section wrapper that adds the standard
 * `px-4 py-3` padding so sections inside a `p-0` dialog line up with
 * the header/footer.
 */
const DialogBody = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col gap-3 px-4 py-3', className)}
    {...props}
  />
);
DialogBody.displayName = 'DialogBody';

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      'text-lg font-semibold leading-tight tracking-tight text-foreground',
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogOverlayScroller,
  OVERLAY_CLASS,
  OVERLAY_CONTENT_CLASS,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
