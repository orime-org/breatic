import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
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
//     and harmful.
const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-chrome text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
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
          'bg-primary text-primary-foreground transition-colors hover-enabled:bg-primary-hover',
        // Destructive (delete) — red-narrowed to the status-error coral tint
        // (2026-06-13): 14% bg + 40% border + readable coral text; hover
        // deepens the border. No more solid brick-red button.
        destructive:
          'border border-status-error-border bg-status-error-bg text-status-error-foreground transition-colors hover-enabled:border-status-error',
        outline:
          'border border-border bg-background hover-enabled:bg-accent hover-enabled:text-accent-foreground',
        secondary:
          'bg-secondary text-secondary-foreground hover-enabled:bg-accent',
        ghost: 'hover-enabled:bg-accent hover-enabled:text-accent-foreground',
        // Chrome variant — TopBar/TabBar 32px buttons default to muted
        // foreground (mock §TopBar v4.0); hover lifts to foreground +
        // accent bg (matches the chrome-baseline mock `.tb-btn:hover` rule).
        // Project-wide rule: hover state only, no active state
        // (per user 2026-05-26 — removed prior `active:bg-secondary`).
        'chrome-ghost':
          'text-muted-foreground hover-enabled:bg-accent hover-enabled:text-foreground',
        link: 'text-primary underline-offset-4 hover-enabled:underline',
      },
      size: {
        // Sizes conform to the Linear-anchored ladder (24/28/32/44) via the
        // --btn-* tokens — `default` 32, `sm` 28, `lg` 44 (= cta), `icon` 32².
        default: 'h-[var(--btn-default)] px-4 py-2',
        // Form-control height (36px) — matches input / select so a submit /
        // create / invite CTA lines up flush with the field above it. Shares
        // the --control-height token with the form controls themselves.
        form: 'h-[var(--control-height)] px-4 py-2',
        sm: 'h-[var(--btn-inline)] px-3',
        // Bottom of the ladder (24px) — a control sitting inside a dense list
        // row or a message's action strip, where the 28px tier would set the
        // row's height instead of fitting inside it.
        compact: 'h-[var(--btn-compact)] px-2',
        lg: 'h-[var(--btn-cta)] px-8',
        icon: 'h-[var(--btn-default)] w-[var(--btn-default)]',
        // Chrome button hit area — 32×32 per `--btn-chrome` token +
        // `--radius-chrome` 6px (overrides base `rounded-md` 12px which
        // looked too round per user feedback). Chrome v4.0 spec used by
        // TopBar / TabBar / popover triggers.
        chrome:
          'h-[var(--btn-chrome)] w-[var(--btn-chrome)] rounded-chrome',
        // Menu-item size — for popover / dropdown internal options
        // (LangSwitcher / ThemeToggle list items). Matches
        // mock `.menu-item` spec: auto height + `--radius-chrome` (6px)
        // + 13px label + asymmetric padding so a stack of items in a
        // 2px-padded popover lines up with the mock proportions.
        'menu-item':
          'h-auto gap-2 rounded-chrome px-2 py-1.5 text-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

// `variant={null}` / `size={null}` mean "bring no chrome of your own". cva
// applies `defaultVariants` only when the prop is `undefined`, so an explicit
// null selects no variant at all and the caller's `className` is the whole
// appearance apart from the base string above. That is the shape most of the
// buttons converted away from a hand-written `<button>` take: the element had
// its own border, fill and metrics already, and picking a variant for them
// would have silently restyled them.
export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Hand the classes to the single child element; `loading` and `icon` are ignored. */
  asChild?: boolean;
  /**
   * Waiting for the server's answer: the button reads as disabled, swallows
   * presses (including the implicit submit of a form) and shows a spinner in
   * place of `icon`, or before the label when there is none. The button is
   * `aria-disabled`, not natively disabled, so a caller's `disabled:` styles
   * need a matching `aria-disabled:` style to apply while it waits.
   */
  loading?: boolean;
  /** Leading icon; its classes size and space the spinner that replaces it. */
  icon?: React.ReactElement<{ className?: string }>;
}

/**
 * Cancel a press made while the button waits. `preventDefault` also cancels
 * the form submission a submit button would start, whether by click or by
 * Enter in one of the form's fields.
 * @param event - The swallowed click.
 */
function swallowPress(event: React.MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, icon, ...props }, ref) => {
    const classes = buttonVariants({ variant, size, className });
    if (asChild) return <Slot {...props} className={cn(classes)} ref={ref} />;
    const { disabled, onClick, children } = props;
    const lead = loading ? (
      <Loader2
        aria-hidden='true'
        className={cn('animate-spin', icon === undefined ? 'mr-2 h-3.5 w-3.5' : icon.props.className)}
      />
    ) : (
      icon
    );
    // While waiting the button stays focusable: a native `disabled` would
    // drop keyboard focus to <body> the moment it is pressed (measured in
    // Chromium 151), and a dialog kept open after a failed reply needs the
    // reader's focus still on its confirm button.
    return (
      <button
        {...props}
        className={cn(classes, loading && 'cursor-not-allowed opacity-50')}
        ref={ref}
        disabled={loading ? undefined : disabled}
        aria-disabled={loading ? true : props['aria-disabled']}
        aria-busy={loading ? true : props['aria-busy']}
        onClick={loading ? swallowPress : onClick}
      >
        {lead}
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
