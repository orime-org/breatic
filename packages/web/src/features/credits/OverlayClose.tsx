// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { X } from 'lucide-react';

import { DialogClose } from '@web/components/ui/dialog';

/** What to call the button. */
interface OverlayCloseProps {
  /** Its accessible name. */
  label: string;
}

/**
 * The X in a panel's top corner.
 *
 * `z-10` is load-bearing: the scroll area filling the panel is a later
 * sibling, and between two positioned elements with no level of their own the
 * later one takes the clicks — without it the button is drawn and nothing
 * reaches it.
 * @param props - The button's accessible name.
 * @param props.label - Its accessible name.
 * @returns The button.
 */
export function OverlayClose({ label }: OverlayCloseProps): React.JSX.Element {
  return (
    <DialogClose
      aria-label={label}
      className='absolute right-3 top-3 z-10 inline-flex h-[var(--btn-chrome)] w-[var(--btn-chrome)] items-center justify-center rounded-chrome text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
    >
      <X className='h-[18px] w-[18px]' />
    </DialogClose>
  );
}
