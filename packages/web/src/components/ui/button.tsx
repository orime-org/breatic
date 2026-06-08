import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@web/lib/utils';

// Disabled state (2026-05-25, PR #137):
//   - `disabled:cursor-not-allowed` — universal stop-sign cursor.
//   - `disabled:opacity-50` — visual dim.
//   - **NO** `disabled:pointer-events-none`. The shadcn vendor default
//     ships `pointer-events-none` here, which lets clicks on a
//     disabled button pass through to whatever sits behind/beside it
//     — silently breaking sibling UX (e.g. tab scroll arrow at the
//     boundary → click lands on adjacent tab → native dblclick selects
//     the tab text). HTML's native `disabled` attribute already swallows
//     the click without forwarding; `pointer-events-none` is redundant
//     and harmful. See memory `feedback_disabled_button_pointer_events_trap`.
const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-chrome text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        // Primary CTA (neutral) — bg-primary with a SOLID hover swap to
        // --color-primary-hover. The 2026-05-21 ADR's opacity-90 pattern
        // was superseded (commit 1031cfc): on the pure-black / pure-white
        // primary, opacity-90 gives <2% perceived hover delta, so a solid
        // one-step swap is used instead (see tokens.css --color-primary-hover).
        // Every studio CTA routes through this variant, so the hover stays
        // consistent (matches the project NewSpaceDialog create button).
        default:
          'bg-primary text-primary-foreground transition-colors hover:bg-primary-hover',
        destructive:
          'bg-destructive text-destructive-foreground transition-opacity hover:opacity-90',
        outline:
          'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-muted',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        // Chrome variant — TopBar/TabBar 32px buttons default to muted
        // foreground (mock §TopBar v4.0); hover lifts to foreground +
        // accent bg (matches the chrome-baseline mock `.tb-btn:hover` rule).
        // Project-wide rule: hover state only, no active state
        // (per user 2026-05-26 — removed prior `active:bg-secondary`).
        'chrome-ghost':
          'text-muted-foreground hover:bg-accent hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 px-3',
        lg: 'h-11 px-8',
        icon: 'h-10 w-10',
        // Chrome button hit area — 32×32 per `--btn-chrome` token +
        // `--radius-chrome` 6px (overrides base `rounded-md` 12px which
        // looked too round per user feedback). Chrome v4.0 spec used by
        // TopBar / TabBar / popover triggers.
        chrome:
          'h-[var(--btn-chrome)] w-[var(--btn-chrome)] rounded-chrome',
        // Menu-item size — for popover / dropdown internal options
        // (LangSwitcher / ThemeToggle / ExportMenu list items). Matches
        // mock `.menu-item` spec: auto height + `--radius-chrome` (6px)
        // + 13px label + asymmetric padding so a stack of items in a
        // 2px-padded popover lines up with the mock proportions.
        'menu-item':
          'h-auto gap-2 rounded-chrome px-2 py-1.5 text-[13px]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
