// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { Avatar, AvatarFallback } from '@web/components/ui/avatar';
import { cn } from '@web/lib/utils';
import type { AnnotationNodeView } from '@web/spaces/canvas/types/node-view';
import { NodeShell } from '@web/spaces/canvas/nodes/_shared/NodeShell';

interface AnnotationNodeProps {
  data: AnnotationNodeView;
  selected?: boolean;
  locked?: boolean;
}

/**
 * Standalone collaboration sticky — not a content node. Used for
 * comments between collaborators (yellow paper aesthetic, 200 px wide).
 * Shows author initial + relative time + the message body.
 *
 * Style stays static so reactions / threading additions remain a
 * non-breaking augmentation in a later PR.
 * @param root0 - Annotation node props.
 * @param root0.data - Annotation payload (message content, author id, created epoch ms).
 * @param root0.selected - Whether the node is selected, driving the selection ring.
 * @param root0.locked - Whether the node is locked, showing the lock indicator.
 * @returns The collaboration sticky node element.
 */
export function AnnotationNode({
  data,
  selected,
  locked,
}: AnnotationNodeProps): React.JSX.Element {
  return (
    <NodeShell
      selected={selected}
      locked={locked}
      className={cn(
        'w-[200px] border-note-border bg-note text-note-foreground',
      )}
      testId='annotation-node'
    >
      <div className='flex items-center gap-2 border-b border-note-border px-2 py-1'>
        <Avatar className='h-5 w-5'>
          <AvatarFallback className='text-2xs'>
            {data.createdBy.slice(0, 1).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className='text-2xs text-muted-foreground'>
          {formatRelative(data.createdAt)}
        </span>
      </div>
      <div
        className='whitespace-pre-wrap px-2 py-2 text-xs'
        data-testid='annotation-node-text'
      >
        {data.content}
      </div>
    </NodeShell>
  );
}

/**
 * Formats an epoch-ms timestamp as a short relative time (e.g. "5m ago"),
 * falling back to a localized date past 30 days or for invalid input.
 * @param epochMs - The creation time as epoch milliseconds.
 * @returns A compact relative-time label.
 */
function formatRelative(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '';
  const diff = Date.now() - epochMs;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(epochMs).toLocaleDateString();
}
