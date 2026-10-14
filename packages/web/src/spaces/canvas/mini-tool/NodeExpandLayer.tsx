// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useStore } from '@xyflow/react';
import * as React from 'react';

import { miniToolById } from '@breatic/shared/mini-tools';

import { useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { miniToolOpenOn } from '@web/stores/canvas-session';
import { useMediaGeometry } from '@web/spaces/canvas/crop/media-geometry';

interface NodeExpandLayerProps {
  /** The node this layer belongs to. */
  nodeId: string;
  /** The node's outer positioned wrapper; see `NodeCropLayer`. */
  wrapper: HTMLElement | null;
}

/**
 * The expand tool's part in the node (inner#1303 §6.3): it covers the node's
 * own picture, which stays put while its copy moves in the frame, and records
 * where the node shows the picture and how far the frame reaches below the
 * node. The frame itself is `ExpandFrameOverlay`, drawn in the canvas's
 * viewport so it outlives the node going off screen.
 * @param root0 - Component props.
 * @param root0.nodeId - The node.
 * @param root0.wrapper - The node's outer wrapper.
 * @returns The cover, or null when no expand tool is open on this node.
 */
export function NodeExpandLayer({ nodeId, wrapper }: NodeExpandLayerProps): React.JSX.Element | null {
  const store = useCanvasSessionStore();
  const draft = useCanvasSession(miniToolOpenOn(nodeId));
  const expand = draft !== null && miniToolById(draft.toolId)?.expand !== undefined ? draft.expand : null;
  const geometry = useMediaGeometry(wrapper, expand !== null);
  // Read only while the layer shows, so a zoom does not re-render it on every node.
  const zoom = useStore((s) => (expand === null ? 1 : s.transform[2]));

  // Where the node shows the picture, for the frame drawn outside the node.
  const heldView = expand?.view ?? null;
  React.useLayoutEffect(() => {
    if (geometry === null || expand === null) return;
    const view = { at: geometry.at, box: geometry.box, src: geometry.src };
    if (JSON.stringify(view) !== JSON.stringify(heldView)) store.getState().setExpandView(view);
  }, [geometry, expand, heldView, store]);

  // How far the frame's bottom edge reaches below the node, for the panel.
  const bottomShare = expand === null ? null : expand.frame.y + expand.shift.y + expand.frame.height;
  const heldDrop = expand?.drop;
  React.useLayoutEffect(() => {
    if (bottomShare === null || geometry === null || wrapper === null) return;
    // In screen pixels, the unit the panel's offset takes.
    const drop = Math.max(0, geometry.at.y + bottomShare * geometry.box.height - wrapper.offsetHeight) * zoom;
    if (Math.abs(drop - (heldDrop ?? 0)) > 0.5) store.getState().setExpandDrop(drop);
  }, [bottomShare, geometry, wrapper, heldDrop, zoom, store]);

  if (expand === null || geometry === null) return null;
  const { box, at } = geometry;
  return (
    // The node's own picture stays put while its copy moves in the frame.
    <div
      data-testid='mini-tool-expand-cover'
      className='pointer-events-none absolute bg-muted'
      style={{ left: at.x, top: at.y, width: box.width, height: box.height }}
    />
  );
}
