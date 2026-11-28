// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The icon-only toolbar button shared by the Motion and Timeline Spaces (inner#1709): its tooltip names
 * it, with its shortcut after the name, and hangs on the wrapping span so a disabled button still names itself.
 */

import * as React from 'react';

import { CountChip } from '@web/components/CountChip';
import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { cn } from '@web/lib/utils';

/** One icon button of a bar. */
interface BarButtonProps {
  testId: string;
  label: string;
  icon: React.ReactElement<{ className?: string }>;
  onClick?: () => void;
  /** The key that does the same, shown after the name on hover. */
  shortcut?: string;
  /** Set for a switch: whether it is on. */
  pressed?: boolean;
  /** A count shown at its top right; zero shows none. */
  count?: number;
  disabled?: boolean;
  unavailable?: boolean;
  loading?: boolean;
  /** Drawn as a filled circle, for the bar's main control (Play). */
  filled?: boolean;
}

/**
 * An icon-only bar button, named by its tooltip (#1490 design §7.1, inner#1709).
 * @param props - The button.
 * @param props.testId - Its test hook.
 * @param props.label - Its name, shown on hover.
 * @param props.icon - Its icon.
 * @param props.onClick - What it does.
 * @param props.shortcut - Its shortcut, shown after the name on hover.
 * @param props.pressed - Whether it is on, for a switch.
 * @param props.count - A count at its top right.
 * @param props.disabled - Whether it is unavailable.
 * @param props.unavailable - Whether it exists but a condition is unmet: dimmed, still clickable so its click can say why.
 * @param props.loading - Whether its press is waiting.
 * @param props.filled - Whether it is drawn as a filled circle.
 * @returns The button.
 * @throws {never} Never.
 */
export const BarButton = React.memo(React.forwardRef<HTMLButtonElement, BarButtonProps>(function BarButton(
  { testId, label, icon, onClick, shortcut, pressed, count = 0, disabled = false, unavailable = false, loading = false, filled = false, ...rest },
  ref,
): React.JSX.Element {
  return <Tooltip>
    <TooltipTrigger asChild>
      <span className='relative inline-flex'>
        <Button ref={ref} {...rest} data-testid={testId} type='button' variant={filled ? 'default' : 'ghost'} size='icon' aria-label={label} aria-pressed={pressed} aria-disabled={unavailable || undefined} disabled={disabled} loading={loading}
          onClick={onClick} icon={icon} className={cn(filled ? 'size-8 rounded-full' : 'size-8 aria-pressed:bg-accent-strong aria-pressed:hover-enabled:bg-accent-strong', unavailable && 'opacity-50')} />
        {count > 0 && <CountChip count={count} className='pointer-events-none absolute -right-1.5 -top-1.5 min-w-[18px] text-center text-2xs' />}
      </span>
    </TooltipTrigger>
    <TooltipContent>{label}{shortcut !== undefined && <kbd className='ml-2 font-sans tracking-widest opacity-70'>{shortcut}</kbd>}</TooltipContent>
  </Tooltip>;
}));
