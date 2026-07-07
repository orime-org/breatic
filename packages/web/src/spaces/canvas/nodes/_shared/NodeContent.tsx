// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { Skeleton } from '@web/components/ui/skeleton';
import { useTranslation } from '@web/i18n/use-translation';
import type { DisplayStatus } from '@web/spaces/canvas/types/node-view';

interface NodeContentProps {
  status: DisplayStatus;
  errorMessage?: string;
  hasContent: boolean;
  placeholder: React.ReactNode;
  content: React.ReactNode;
  /**
   * Retry a failed upload (#1609 P4) — present only while the session
   * still stashes the failed File; the error branch then renders a
   * Retry button. Pre-bound to the node id by the canvas.
   */
  onRetry?: () => void;
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
 * @param root0.onRetry - Retry a failed upload; when present the error branch renders a Retry button (#1609 P4).
 * @returns The branch element for the current node state.
 */
export function NodeContent({
  status,
  errorMessage,
  hasContent,
  placeholder,
  content,
  onRetry,
}: NodeContentProps): React.JSX.Element {
  const t = useTranslation();
  if (status === 'handling') {
    // The skeleton fills the fixed empty-state box (288 x 192) so a node that is
    // generating keeps the footprint it had while empty, then grows to its real
    // size once content arrives — no tiny centered bar, no collapse.
    return (
      <div data-testid='node-content-handling' className='h-48 w-full'>
        <Skeleton
          data-testid='node-content-skeleton'
          className='h-full w-full rounded-none'
        />
      </div>
    );
  }
  if (status === 'error') {
    // Fixed h-48 box like the empty + handling branches (#1632): every node's
    // three "no displayable content" states (empty / generating / error) keep
    // the same 288×192 footprint. h-full would let the height collapse to a
    // single line of error text, making the node a flat wide bar. Shared by
    // all 6 content modalities (image/video/audio/text/3d/web).
    return (
      <div
        data-testid='node-content-error'
        className='flex h-48 w-full flex-col items-center justify-center gap-2 p-3 text-xs text-status-error-foreground'
      >
        <span>{errorMessage ?? 'Something went wrong.'}</span>
        {onRetry ? (
          <button
            type='button'
            data-testid='node-content-retry'
            className='nodrag rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted focus-visible:outline-2'
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
          >
            {t('canvas.upload.retry')}
          </button>
        ) : null}
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
