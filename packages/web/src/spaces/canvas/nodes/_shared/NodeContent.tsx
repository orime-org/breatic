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
    return (
      <div
        data-testid='node-content-handling'
        className='flex h-full w-full items-center justify-center p-3'
      >
        <Skeleton className='h-16 w-full' />
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
  return hasContent ? <>{content}</> : <>{placeholder}</>;
}
