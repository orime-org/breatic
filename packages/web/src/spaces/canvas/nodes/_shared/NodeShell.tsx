// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Lock } from 'lucide-react';

import { cn } from '@web/lib/utils';

interface NodeShellProps {
  selected?: boolean;
  locked?: boolean;
  children: React.ReactNode;
  className?: string;
  /** Forwarded down for stable e2e selectors per type node. */
  testId?: string;
}

// The node carries a single 1px border that answers to selection and hover
// alone; a node shows no task state (inner#888 §7.8). One flat border, no
// rings or focus glow (rigid 1px rule, breatic/one-px-border). Hover changes
// ONLY the border (never the background), and never the selected colour.
const IDLE_BORDER = 'border-border hover:border-foreground-disabled';

/**
 * Unified outer shell for every canvas node (text / image / audio / video
 * / annotation). Owns the single 1px border (selection / hover colour),
 * the lock indicator, AND the corner clip (`overflow-hidden`) so type nodes
 * only have to render their body. The clip is the concentric-radius fix
 * (user report 2026-07-03): the shell is rounded with a 1px border and zero
 * padding, so any edge-touching child (image, iframe, text fade)
 * carrying its own radius curves faster than the border's inner
 * arc and opens a gap in all four corners — the shell clipping every child
 * to its rounded box makes that geometry impossible by construction.
 *
 * The one 1px border is neutral, darker on hover, and the selected colour
 * while selected.
 * @param root0 - Node shell props.
 * @param root0.selected - Whether the node is selected, tinting its own 1px border with the selected colour (no ring / offset).
 * @param root0.locked - Whether the node is locked, rendering the lock indicator.
 * @param root0.children - The type node's body rendered inside the shell.
 * @param root0.className - Extra classes merged onto the shell (per-modality sizing / color).
 * @param root0.testId - Stable test id for the shell root, per type node.
 * @returns The outer node shell element wrapping the body.
 */
export function NodeShell({
  selected = false,
  locked = false,
  children,
  className,
  testId,
}: NodeShellProps): React.JSX.Element {
  return (
    <div
      data-testid={testId ?? 'node-shell'}
      data-selected={selected ? 'true' : 'false'}
      data-locked={locked ? 'true' : 'false'}
      className={cn(
        // `canvas-node-shell` is the stable hook the drag-lift CSS rule targets
        // (`.react-flow__node.dragging .canvas-node-shell` → shadow in index.css);
        // a static card is flat — no shadow — per the design system.
        'canvas-node-shell relative overflow-hidden rounded-sm border bg-card text-card-foreground transition-colors',
        selected ? 'border-status-selected' : IDLE_BORDER,
        className,
      )}
    >
      {locked ? (
        <div
          aria-hidden='true'
          data-testid='node-lock-indicator'
          className='absolute right-1 top-1 rounded-full bg-muted p-0.5 text-muted-foreground'
        >
          <Lock className='h-3 w-3' />
        </div>
      ) : null}
      {children}
    </div>
  );
}
