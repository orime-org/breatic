// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { cn } from '@web/lib/utils';
import type { NodeStatus } from '@web/spaces/canvas/types/node';

interface NodeShellProps {
  status?: NodeStatus;
  selected?: boolean;
  locked?: boolean;
  children: React.ReactNode;
  className?: string;
  /** Forwarded down for stable e2e selectors per type node. */
  testId?: string;
}

const STATUS_RING: Record<NodeStatus, string> = {
  idle: '',
  handling: 'ring-2 ring-status-info ring-offset-2',
  error: 'ring-2 ring-status-error ring-offset-2',
};

/**
 * Unified outer shell for every canvas node (text / image / audio / video
 * / annotation). Owns the visual border, selection ring, status ring,
 * and lock indicator so type nodes only have to render their body.
 *
 * Status semantics:
 *   - `idle`     → no ring
 *   - `handling` → info ring (AI generating / mini-tool running)
 *   - `error`    → error ring (last operation failed)
 * @param root0 - Node shell props.
 * @param root0.status - Node status, selecting the status ring (idle / handling / error).
 * @param root0.selected - Whether the node is selected, drawing the primary selection ring.
 * @param root0.locked - Whether the node is locked, rendering the lock indicator.
 * @param root0.children - The type node's body rendered inside the shell.
 * @param root0.className - Extra classes merged onto the shell (per-modality sizing / color).
 * @param root0.testId - Stable test id for the shell root, per type node.
 * @returns The outer node shell element wrapping the body.
 */
export function NodeShell({
  status = 'idle',
  selected = false,
  locked = false,
  children,
  className,
  testId,
}: NodeShellProps): React.JSX.Element {
  return (
    <div
      data-testid={testId ?? 'node-shell'}
      data-status={status}
      data-selected={selected ? 'true' : 'false'}
      data-locked={locked ? 'true' : 'false'}
      className={cn(
        'relative rounded-lg border border-border bg-card text-card-foreground shadow-sm transition-colors',
        selected && 'ring-2 ring-primary ring-offset-2',
        !selected && STATUS_RING[status],
        className,
      )}
    >
      {locked ? (
        <div
          aria-hidden='true'
          data-testid='node-lock-indicator'
          className='absolute right-1 top-1 rounded-full bg-muted px-1 text-2xs text-muted-foreground'
        >
          lock
        </div>
      ) : null}
      {children}
    </div>
  );
}
