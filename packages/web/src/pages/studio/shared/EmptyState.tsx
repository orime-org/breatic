// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Plus, type LucideIcon } from 'lucide-react';

import { Button } from '@web/components/ui/button';

interface EmptyStateAction {
  /** Button label (resolved i18n). */
  label: string;
  /** Invoked on click — e.g. opens the create dialog. */
  onClick: () => void;
}

interface EmptyStateProps {
  /** Lucide glyph shown in the rounded icon tile (rendered at 22px). */
  icon: LucideIcon;
  /** Empty-state headline. */
  title: string;
  /** One-line supporting copy (wraps at ~320px). */
  hint: string;
  /** Optional create-style CTA (a `+` button); omit for a passive empty state. */
  action?: EmptyStateAction;
}

/**
 * Shared studio empty state (neutral mock §empty) — a centered icon tile +
 * title + hint, with an optional create CTA. One component for every "nothing
 * here yet" view in the studio (the Recent landing, the Projects / Collections
 * tabs), so they read identically and the look lives in one place.
 * @param props - the icon, the title + hint copy and an optional CTA.
 * @param props.icon - the Lucide glyph for the icon tile.
 * @param props.title - the empty-state headline.
 * @param props.hint - the supporting copy.
 * @param props.action - the optional create CTA (label + handler).
 * @returns the centered empty-state block.
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className='flex flex-col items-center justify-center gap-2.5 px-4 py-[72px] text-center'>
      <div className='flex h-12 w-12 items-center justify-center rounded-chrome bg-muted text-muted-foreground'>
        <Icon className='h-[22px] w-[22px]' aria-hidden='true' />
      </div>
      <p className='text-sm font-semibold text-foreground'>{title}</p>
      <p className='max-w-[320px] text-xs text-muted-foreground'>{hint}</p>
      {action ? (
        <Button
          type='button'
          onClick={action.onClick}
          className='mt-1 h-[var(--control-height)] gap-1.5 rounded-chrome px-3.5 text-xs font-semibold'
        >
          <Plus className='h-3.5 w-3.5' aria-hidden='true' />
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
