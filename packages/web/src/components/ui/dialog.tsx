import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '@web/lib/utils';

/**
 * shadcn/ui Dialog — modal dialog backed by @radix-ui/react-dialog.
 *
 * Use for non-destructive modals (forms / settings / wizards). For
 * irreversible / destructive confirmations use `AlertDialog` instead.
 *
 * Layout convention (per chrome-baseline `.modal-dialog`):
 *   - container: 520 px max, 6 px radius, popover bg, p-0 (sections own padding)
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

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 flex w-full max-w-[520px] translate-x-[-50%] translate-y-[-50%] flex-col border border-border bg-popover p-0 shadow duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-overlay',
        className,
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
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
    <div className='flex min-w-0 flex-col gap-1 text-left'>{children}</div>
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
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
