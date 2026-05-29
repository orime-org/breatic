import * as React from 'react';

import { Skeleton } from '@web/components/ui/skeleton';
import type { NodeStatus } from '@web/spaces/canvas/types/node';

interface NodeContentProps {
  status: NodeStatus;
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
 */
export function NodeContent({
  status,
  errorMessage,
  hasContent,
  placeholder,
  content,
}: NodeContentProps) {
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
        className='flex h-full w-full items-center justify-center p-3 text-xs text-destructive'
      >
        {errorMessage ?? 'Something went wrong.'}
      </div>
    );
  }
  return hasContent ? <>{content}</> : <>{placeholder}</>;
}
