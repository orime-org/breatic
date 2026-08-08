// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';

interface StudioChromeIconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Lucide icon component rendered at 18px. */
  icon: LucideIcon;
  /** Accessible label (also the tooltip text). */
  label: string;
}

/**
 * Neutral 32x32 chrome icon button for the studio top-bar tool cluster
 * (search / language / theme). Stays monochrome per chrome-baseline §F10
 * — only the logo + studio switcher use brand color (studio spec §1.2).
 *
 * `forwardRef` + prop spread so it can back a Radix `PopoverTrigger asChild`
 * (the language / theme switchers) as well as a plain static button (search).
 */
export const StudioChromeIconButton = React.forwardRef<
  HTMLButtonElement,
  StudioChromeIconButtonProps
>(({ icon: Icon, label, className, ...props }, ref) => {
  return (
    <Button
      ref={ref}
      type='button'
      aria-label={label}
      title={label}
      variant='chrome-ghost'
      size='chrome'
      className={cn(
        'flex h-8 w-8 rounded-chrome text-neutral-600 hover:bg-accent hover:text-foreground',
        className,
      )}
      {...props}
    >
      <Icon className='h-[18px] w-[18px]' />
    </Button>
  );
});
StudioChromeIconButton.displayName = 'StudioChromeIconButton';
