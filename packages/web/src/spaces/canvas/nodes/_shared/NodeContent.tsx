// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import type { DisplayStatus } from '@web/spaces/canvas/types/node-view';

interface NodeContentProps {
  status: DisplayStatus;
  errorMessage?: string;
  hasContent: boolean;
  placeholder: React.ReactNode;
  content: React.ReactNode;
  /**
   * Open this node's task list. Present when the failure is a task's, which
   * is where the reason for it lives; absent for text extracted in the
   * browser, which never reaches the task table (#186 §3.7.4).
   */
  onViewTasks?: () => void;
}

/**
 * Switches between placeholder / error / content based on the node's
 * `status` and whether a content payload exists. A node with a task running
 * keeps showing whatever it already holds — the counts beside it are what
 * says something is running (user 2026-09-06).
 * Type-node bodies pass their modality-specific renderers; this atom
 * owns the state-machine wiring.
 * @param root0 - Node content props.
 * @param root0.status - Node status that selects the branch (error / content).
 * @param root0.errorMessage - Message shown in the error branch when status is `error`.
 * @param root0.hasContent - Whether a content payload exists, choosing content vs placeholder when idle.
 * @param root0.placeholder - Empty-state node rendered when idle with no content.
 * @param root0.content - Modality-specific body rendered when idle with content.
 * @param root0.onViewTasks - Open this node's task list; when present the error branch offers it.
 * @returns The branch element for the current node state.
 */
export function NodeContent({
  status,
  errorMessage,
  hasContent,
  placeholder,
  content,
  onViewTasks,
}: NodeContentProps): React.JSX.Element {
  const t = useTranslation();
  if (status === 'error') {
    // Fixed h-48 box like the empty branch (#1632): both of a node's "nothing
    // displayable" states (empty / error) keep the same 288×192 footprint.
    // h-full would let the height collapse to a
    // single line of error text, making the node a flat wide bar. Shared by
    // all 6 content modalities (image/video/audio/text/3d/web).
    return (
      <div
        data-testid='node-content-error'
        className='flex h-48 w-full flex-col items-center justify-center gap-2 p-3 text-xs text-status-error-foreground'
      >
        {/* A task's own reason — which task, who started it, why it failed —
            is a row in the task list, said in the reader's own language. The
            node carries one sentence. The other branch is the text this
            browser could not extract, which has no row anywhere. */}
        <span>{errorMessage ?? t('canvas.task.someFailed')}</span>
        {onViewTasks ? (
          <Button
            type='button'
            variant={null}
            size={null}
            data-testid='node-content-view-tasks'
            className='nodrag rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted focus-visible:outline-2'
            onClick={(event) => {
              event.stopPropagation();
              onViewTasks();
            }}
          >
            {t('canvas.task.view')}
          </Button>
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
