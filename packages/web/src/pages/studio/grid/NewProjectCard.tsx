// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Plus } from 'lucide-react';

interface NewProjectCardProps {
  onClick: () => void;
}

/**
 * "Create new project" tile — dashed border, plus icon, click opens
 * `NewProjectDialog`.
 * @param root0 - component props
 * @param root0.onClick - called when the tile is clicked, to open the create dialog
 * @returns a dashed-border button tile for starting a new project.
 */
export function NewProjectCard({ onClick }: NewProjectCardProps): React.JSX.Element {
  return (
    <button
      type='button'
      onClick={onClick}
      className='group flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-card text-muted-foreground transition-colors hover:border-neutral-400 hover:bg-muted hover:text-foreground'
      aria-label='Create new project'
    >
      <Plus className='h-6 w-6' />
      <span className='text-sm font-medium'>New project</span>
    </button>
  );
}
