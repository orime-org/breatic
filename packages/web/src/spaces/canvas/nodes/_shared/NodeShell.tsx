// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { cn } from '@web/lib/utils';
import type { DisplayStatus } from '@web/spaces/canvas/types/node-view';

interface NodeShellProps {
  status?: DisplayStatus;
  selected?: boolean;
  locked?: boolean;
  children: React.ReactNode;
  className?: string;
  /** Forwarded down for stable e2e selectors per type node. */
  testId?: string;
}

// The node carries a single 1px border whose colour reflects its state.
// One flat border, no rings or focus glow (rigid 1px rule, lint:1px-border).
const STATUS_BORDER: Record<DisplayStatus, string> = {
  idle: 'border-border',
  handling: 'border-status-info',
  error: 'border-status-error',
};

/**
 * Unified outer shell for every canvas node (text / image / audio / video
 * / annotation). Owns the single 1px state border (selection / status colour)
 * and the lock indicator so type nodes only have to render their body.
 *
 * The one 1px border is tinted by state (selected wins over status):
 *   - `idle`     → neutral border
 *   - `handling` → info border (AI generating / mini-tool running)
 *   - `error`    → error border (last operation failed)
 *   - selected   → selected border (overrides any status colour)
 * @param root0 - Node shell props.
 * @param root0.status - Node status, tinting the 1px border (idle / handling / error).
 * @param root0.selected - Whether the node is selected, tinting its own 1px border with the selected colour (no ring / offset).
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
        'relative rounded-lg border bg-card text-card-foreground shadow-sm transition-colors',
        selected ? 'border-status-selected' : STATUS_BORDER[status],
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
