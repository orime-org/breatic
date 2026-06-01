import * as React from 'react';

import { cn } from '@web/lib/utils';

interface TopBarTextIconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Left-side icon (Lucide React component already rendered). */
  icon?: React.ReactNode;
  /** Optional right-side chevron-down (mock shows it on dropdown triggers). */
  withChevron?: boolean;
  children: React.ReactNode;
}

/**
 * `.tb-btn` analog — shared button atom for TopBar group A (text-icon
 * popover triggers: Tweaks / Members / Lang / Theme).
 *
 * Mock spec (chrome-baseline § TopBar v4.0):
 *   - height 32px (`--btn-chrome`)
 *   - inline icon + label + optional chevron-down
 *   - 13px label, gap `--space-2` (4px) between icon/label/chevron
 *   - hover bg `--neutral-100`
 *   - rounded `--radius-chrome` (6px)
 */
export const TopBarTextIconButton = React.forwardRef<
  HTMLButtonElement,
  TopBarTextIconButtonProps
>(({ className, icon, withChevron, children, ...props }, ref) => {
  return (
    <button
      ref={ref}
      type='button'
      className={cn(
        'inline-flex shrink-0 items-center text-[13px] font-normal text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        className,
      )}
      style={{
        height: 'var(--btn-chrome)',
        padding: '0 var(--space-4)',
        gap: 'var(--space-3)',
        borderRadius: 'var(--radius-chrome)',
      }}
      {...props}
    >
      {icon}
      <span>{children}</span>
      {withChevron ? <ChevronDown /> : null}
    </button>
  );
});
TopBarTextIconButton.displayName = 'TopBarTextIconButton';

/**
 * Small chevron-down glyph rendered on dropdown-trigger buttons.
 * @returns the inline chevron-down SVG icon.
 */
function ChevronDown(): React.JSX.Element {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.75'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      style={{ opacity: 0.5 }}
    >
      <path d='m6 9 6 6 6-6' />
    </svg>
  );
}
