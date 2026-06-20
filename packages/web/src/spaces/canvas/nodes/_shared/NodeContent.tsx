// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { Skeleton } from '@web/components/ui/skeleton';
import type { DisplayStatus } from '@web/spaces/canvas/types/node-view';

interface NodeContentProps {
  status: DisplayStatus;
  errorMessage?: string;
  hasContent: boolean;
  placeholder: React.ReactNode;
  content: React.ReactNode;
}

/**
 * Switches between placeholder / handling skeleton / error / content
 * based on the node's `status` and whether a content payload exists.
 * Type-node bodies pass their modality-specific renderers; this atom
 * owns the state-machine wiring.
 * @param root0 - Node content props.
 * @param root0.status - Node status that selects the branch (handling skeleton / error / content).
 * @param root0.errorMessage - Message shown in the error branch when status is `error`.
 * @param root0.hasContent - Whether a content payload exists, choosing content vs placeholder when idle.
 * @param root0.placeholder - Empty-state node rendered when idle with no content.
 * @param root0.content - Modality-specific body rendered when idle with content.
 * @returns The branch element for the current node state.
 */
export function NodeContent({
  status,
  errorMessage,
  hasContent,
  placeholder,
  content,
}: NodeContentProps): React.JSX.Element {
  if (status === 'handling') {
    // The skeleton fills the fixed empty-state box (288 x 192) so a node that is
    // generating keeps the footprint it had while empty, then grows to its real
    // size once content arrives — no tiny centered bar, no collapse.
    return (
      <div data-testid='node-content-handling' className='h-48 w-full p-2'>
        <Skeleton
          data-testid='node-content-skeleton'
          className='h-full w-full'
        />
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div
        data-testid='node-content-error'
        className='flex h-full w-full items-center justify-center p-3 text-xs text-status-error-foreground'
      >
        {errorMessage ?? 'Something went wrong.'}
      </div>
    );
  }
  // An empty node fills a fixed h-48 box so every empty node is the same size
  // regardless of modality; a filled node grows to its content's real height.
  return hasContent ? (
    <>{content}</>
  ) : (
    <div data-testid='node-content-empty' className='h-48'>
      {placeholder}
    </div>
  );
}
