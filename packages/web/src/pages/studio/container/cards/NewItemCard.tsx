// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Plus } from 'lucide-react';

interface NewItemCardProps {
  /** The localized "+ New project" / "+ New collection" label. */
  label: string;
  /** Opens the matching create dialog (spec §3.12). */
  onClick?: () => void;
}

/**
 * The dashed "new item" card shown at the end of the Projects / Collections
 * grids and as the empty-state call to action (spec §3.13). A plain button
 * (not a link) — it opens a create dialog rather than navigating.
 * @param props the label and click handler.
 * @param props.label the display label.
 * @param props.onClick the click handler.
 * @returns the new-item card.
 */
export function NewItemCard({
  label,
  onClick,
}: NewItemCardProps): React.JSX.Element {
  return (
    <button
      type='button'
      onClick={onClick}
      className='flex h-full min-h-[180px] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-neutral-300 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
    >
      <Plus className='h-5 w-5' aria-hidden='true' />
      {label}
    </button>
  );
}
