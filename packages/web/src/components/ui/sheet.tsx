import * as React from 'react';
import * as SheetPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';

import { cn } from '@web/lib/utils';

/**
 * shadcn/ui Sheet — slide-in panel from any screen edge.
 *
 * Built on top of Radix Dialog primitive with a `side` variant that slides
 * in from `top` / `right` (default) / `bottom` / `left`. Useful for drawers
 * (e.g. SpaceDrawer, ConversationHistorySheet, mobile menus).
 */
/**
 * Project default (2026-05-25): Sheets are **non-modal** unless the
 * caller explicitly opts in by passing `modal={true}`. Non-modal:
 *   - no backdrop overlay (no half-transparent darkening of the page)
 *   - sibling UI (tab bar, top bar, other buttons) stay clickable
 *   - Esc / click-outside still close the sheet
 * Combined with `useExclusiveOverlay`, only one Sheet / Dialog is
 * visible at a time across the app (opening a new one closes any
 * peer). See `lib/use-exclusive-overlay.ts`.
 */
const Sheet = ({
  modal = false,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Root>) => (
  <SheetPrimitive.Root modal={modal} {...props} />
);
Sheet.displayName = 'Sheet';

const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      'fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
    ref={ref}
  />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

// Drops vendor shadcn's default `gap-4` from the base class
// (PR #138 followup, user-reported "blank purple band"). The gap was
// harmless for sheets using the default block layout, but as soon as
// a consumer opts into `flex flex-col` (the common pattern when
// SheetContent contains a fixed header + a flex-1 scrollable list),
// the inherited `gap-4` injected an unwanted 16px gap between the
// header and the list. Consumers that genuinely want spacing between
// children can add `gap-N` themselves.
const sheetVariants = cva(
  'fixed z-50 bg-card p-6 shadow transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500',
  {
    variants: {
      side: {
        top: 'inset-x-0 top-0 border-b border-border data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
        bottom:
          'inset-x-0 bottom-0 border-t border-border data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
        left: 'inset-y-0 left-0 h-full w-3/4 border-r border-border data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm',
        right:
          'inset-y-0 right-0 h-full w-3/4 border-l border-border data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm',
        /**
         * Floating variants — sheet sits inside the chrome instead of
         * covering full vh. Top edge sits 4px below the chrome row
         * above it (right-floating: TopBar 40 + TabBar 40 + 4 gap =
         * 84px; left-floating: TopBar 40 + Agent header 40 + 4 gap =
         * 84px — both share the same `top-[84px]`). Bottom leaves
         * room for the ViewportToolbar (~bottom-4 + toolbar ~40 +
         * buffer 24). Lateral inset 4px so the sheet floats off the
         * viewport edge. Used by:
         *   - SpaceDrawer (right-floating)
         *   - SpaceReadOnlySheet (right-floating)
         *   - ProjectMessagesButton (right-floating)
         *   - ConversationHistorySheet (left-floating)
         */
        'right-floating':
          'top-[84px] bottom-20 right-1 h-auto w-3/4 rounded-overlay border border-border shadow data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm',
        'left-floating':
          'top-[84px] bottom-20 left-1 h-auto w-3/4 rounded-overlay border border-border shadow data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm',
      },
    },
    defaultVariants: {
      side: 'right',
    },
  },
);

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {
  /**
   * Show the half-transparent backdrop overlay. Default `false` per
   * 2026-05-25 user decision — Sheets are non-modal by default so
   * sibling UI stays clickable. Pass `true` for the rare case the
   * sheet must steal full attention (destructive confirms etc.).
   */
  withOverlay?: boolean;
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = 'right', className, children, withOverlay = false, ...props }, ref) => (
  <SheetPortal>
    {withOverlay ? <SheetOverlay /> : null}
    <SheetPrimitive.Content
      ref={ref}
      className={cn(sheetVariants({ side }), className)}
      {...props}
    >
      {children}
      <SheetPrimitive.Close
        aria-label='Close'
        className='absolute right-3 top-3 inline-flex h-[var(--btn-chrome)] w-[var(--btn-chrome)] shrink-0 items-center justify-center rounded-chrome text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none'
      >
        <X className='h-[18px] w-[18px]' />
        <span className='sr-only'>Close</span>
      </SheetPrimitive.Close>
    </SheetPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = SheetPrimitive.Content.displayName;

const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col space-y-2 text-center sm:text-left',
      className,
    )}
    {...props}
  />
);
SheetHeader.displayName = 'SheetHeader';

const SheetFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2',
      className,
    )}
    {...props}
  />
);
SheetFooter.displayName = 'SheetFooter';

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold text-foreground', className)}
    {...props}
  />
));
SheetTitle.displayName = SheetPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
SheetDescription.displayName = SheetPrimitive.Description.displayName;

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetPortal,
  SheetOverlay,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
