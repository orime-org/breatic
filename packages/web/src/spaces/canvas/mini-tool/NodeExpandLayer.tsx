// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

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
 * where the node shows the picture. The frame itself is `ExpandFrameOverlay`, drawn in the canvas's
 * viewport so it outlives the node going off screen.
 * @param root0 - Component props.
 * @param root0.nodeId - The node.
 * @param root0.wrapper - The node's outer wrapper.
 * @returns The cover, or null when no expand tool is open on this node.
 */
export function NodeExpandLayer({ nodeId, wrapper }: NodeExpandLayerProps): React.JSX.Element | null {
  const store = useCanvasSessionStore();
  const draft = useCanvasSession(miniToolOpenOn(nodeId));
  const expand = draft?.expand ?? null;
  const geometry = useMediaGeometry(wrapper, expand !== null);

  // Where the node shows the picture, for the frame drawn outside the node.
  // The store skips a view equal to the one it holds. The held view is a
  // dependency so a source reset, which clears it, writes it again.
  const heldView = expand?.view ?? null;
  React.useLayoutEffect(() => {
    if (geometry === null || expand === null) return;
    store.getState().setExpandView({ at: geometry.at, box: geometry.box, src: geometry.src });
  }, [geometry, expand, heldView, store]);

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
