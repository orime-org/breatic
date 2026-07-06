// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { cn } from '@web/lib/utils';
import { NodeHeader } from '@web/spaces/canvas/nodes/_shared/NodeHeader';
import {
  NodeResolutionBadge,
  type NodeResolution,
} from '@web/spaces/canvas/nodes/_shared/NodeResolutionBadge';
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
  /**
   * Intrinsic media resolution (image/video only); when set, a pixel-size
   * badge mirrors the name header at the card's top-right. Omit / undefined
   * (empty node, or media not yet loaded) → no badge.
   */
  resolution?: NodeResolution;
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
 * A locked node's name is frozen: the name is on-canvas content (a header
 * label edited inline), so lock gates rename like every canvas/whiteboard tool
 * (tldraw / Miro / FigJam) — decision 2026-06-20, reversing the 2026-06-17
 * "name is metadata" carve-out. Canvas-wide viewer-role read-only is a
 * separate, not-yet-plumbed concern (no role context in the canvas body).
 * @param root0 - Content node frame props.
 * @param root0.modality - Node modality, selecting the header icon + label.
 * @param root0.name - Current node name (blank → modality label fallback).
 * @param root0.status - Node status, tinting the shell's 1px state border.
 * @param root0.selected - Whether the node is selected, tinting the shell border.
 * @param root0.locked - Whether the node is locked; drives the shell lock indicator AND freezes the name.
 * @param root0.onRename - Commit a rename, pre-bound to this node's id.
 * @param root0.className - Extra classes merged onto the shell (sizing).
 * @param root0.testId - Stable test id for the shell root.
 * @param root0.resolution - Intrinsic media resolution; renders the top-right pixel-size badge when set.
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
  resolution,
  children,
}: ContentNodeFrameProps): React.JSX.Element {
  // The name header floats in an absolutely-positioned anchor pinned just above
  // the card's top-left, counter-scaled by the canvas zoom so it keeps a
  // constant screen size. Taking it out of flow makes the frame's in-flow box
  // the card alone, which centres the wrapper's Left/Right connection handles on
  // the card body. The bottom padding is the (constant) gap to the card.
  //
  // The resolution badge (image/video only) is a MIRROR anchor pinned to the
  // card's top-RIGHT, counter-scaled from `origin-bottom-right` so it stays
  // glued to the card's right corner at every zoom. It must be its OWN
  // corner-pinned anchor, NOT a right item in a full-width row: a full-width row
  // has a constant screen width while the card's screen width scales with zoom,
  // so at >100% the badge would land mid-card and at <100% it would spill past
  // the right edge (#1616). It is gated on the media actually being displayed
  // (idle) — during regeneration (handling → skeleton) or error the media
  // element is unmounted, so a previously-read resolution must not linger.
  // At low zoom the two constant-size labels can overlap a long name into the
  // badge; that is accepted (user, 2026-07-06) — low zoom is for overview /
  // moving nodes, not editing, so a corner-pinned badge matters more than the
  // overlap.
  const headerScale = React.useContext(NodeScaleContext);
  const mediaShown = status !== 'handling' && status !== 'error';
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
          selected={selected}
          locked={locked}
          onRename={onRename}
        />
      </div>
      {mediaShown && resolution && (
        <div
          data-testid='node-resolution-anchor'
          className='absolute bottom-full right-0 origin-bottom-right pb-1'
          style={{ transform: `scale(${headerScale})` }}
        >
          <NodeResolutionBadge
            width={resolution.width}
            height={resolution.height}
            selected={selected}
          />
        </div>
      )}
      <NodeShell
        status={status}
        selected={selected}
        locked={locked}
        className={cn('w-72', className)}
        testId={testId}
      >
        {children}
      </NodeShell>
    </div>
  );
}
