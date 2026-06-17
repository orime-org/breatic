// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { NodeHeader } from '@web/spaces/canvas/nodes/_shared/NodeHeader';
import { NodeScaleContext } from '@web/spaces/canvas/nodes/_shared/node-scale';
import { NodeShell } from '@web/spaces/canvas/nodes/_shared/NodeShell';
import type {
  DisplayStatus,
  Modality,
} from '@web/spaces/canvas/types/node-view';

interface ContentNodeFrameProps {
  /** Modality, selecting the header icon + fixed-English label fallback. */
  modality: Modality;
  /** Current node name (blank → modality label). */
  name?: string;
  status?: DisplayStatus;
  selected?: boolean;
  locked?: boolean;
  /** Commit a rename — pre-bound to this node's id by the ReactFlow wrapper. */
  onRename?: (name: string) => void;
  /** Extra classes for the shell (per-modality sizing). */
  className?: string;
  /** Stable test id for the shell root, per type node. */
  testId?: string;
  /** The modality body rendered inside the shell. */
  children: React.ReactNode;
}

/**
 * Shared frame for the 6 content modalities: the always-on name header
 * (icon + editable name, fixed size, left-aligned) above the node body
 * shell. Extracted so every content node composes the header + shell the
 * same way and the rename plumbing lives in one place. The annotation
 * sticky (its own header) and the group container do not use this frame.
 *
 * A locked node's name stays editable: lock only restricts structural ops
 * (move / delete); the name is metadata so renaming is never gated by lock
 * (decision 2026-06-17 — else the locker can't fix a name an editor can still
 * undo). Canvas-wide viewer-role read-only is a separate, not-yet-plumbed
 * concern (no role context in the canvas body).
 * @param root0 - Content node frame props.
 * @param root0.modality - Node modality, selecting the header icon + label.
 * @param root0.name - Current node name (blank → modality label fallback).
 * @param root0.status - Node status, tinting the shell's 1px state border.
 * @param root0.selected - Whether the node is selected, tinting the shell border.
 * @param root0.locked - Whether the node is locked (drives the shell lock indicator only; does NOT lock the name).
 * @param root0.onRename - Commit a rename, pre-bound to this node's id.
 * @param root0.className - Extra classes merged onto the shell (sizing).
 * @param root0.testId - Stable test id for the shell root.
 * @param root0.children - The modality body rendered inside the shell.
 * @returns The header-over-shell content node frame.
 */
export function ContentNodeFrame({
  modality,
  name,
  status,
  selected,
  locked,
  onRename,
  className,
  testId,
  children,
}: ContentNodeFrameProps): React.JSX.Element {
  // The header floats in an absolutely-positioned anchor pinned just above the
  // card's top-left, counter-scaled by the canvas zoom so it keeps a constant
  // screen size. Taking it out of flow makes the frame's in-flow box the card
  // alone, which is what centres the wrapper's Left/Right connection handles on
  // the card body rather than the header+card stack. The bottom padding is the
  // (constant, zoom-independent) gap between the header and the card.
  const headerScale = React.useContext(NodeScaleContext);
  return (
    <div className='relative'>
      <div
        data-testid='node-header-anchor'
        className='absolute bottom-full left-0 origin-bottom-left pb-1'
        style={{ transform: `scale(${headerScale})` }}
      >
        <NodeHeader
          modality={modality}
          name={name}
          onRename={onRename}
        />
      </div>
      <NodeShell
        status={status}
        selected={selected}
        locked={locked}
        className={className}
        testId={testId}
      >
        {children}
      </NodeShell>
    </div>
  );
}
