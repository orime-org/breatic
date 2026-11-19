// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useStore } from '@xyflow/react';
import * as React from 'react';

import { useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { miniToolOpenOn } from '@web/stores/canvas-session';
import { useVideoDisplayGeometry } from '@web/spaces/canvas/video-presentation/video-display-geometry';
import { useMediaGeometry } from '@web/spaces/canvas/crop/media-geometry';
import { handleScale } from '@web/spaces/canvas/crop/crop-geometry';
import { checkerboardStyle } from '@web/spaces/canvas/_shared/checkerboard';

interface NodeExpandLayerProps {
  /** The node this layer belongs to. */
  nodeId: string;
  /** The node's outer positioned wrapper; see `NodeCropLayer`. */
  wrapper: HTMLElement | null;
}

/**
 * The expand tool's part in the node (inner#1303 §6.3): it covers the node's
 * own picture, whose fixed copy is drawn over the frame fill, and records
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
  const video = draft?.toolId === 'video.expand';
  const picture = useMediaGeometry(wrapper, expand !== null && !video);
  const display = useVideoDisplayGeometry(wrapper, expand !== null && video);
  const geometry = video ? display : picture;
  // Read only while the tool is open, so a zoom does not re-render every node.
  const zoom = useStore((s) => (expand === null ? 1 : s.transform[2]));

  // Where the node shows the picture, for the frame drawn outside the node.
  // The store skips a view equal to the one it holds. A source reset clears
  // the view and hands over a new draft, which runs this again.
  React.useLayoutEffect(() => {
    if (geometry === null || expand === null) return;
    store.getState().setExpandView({ at: geometry.at, box: geometry.box, src: geometry.src });
  }, [geometry, expand, store]);

  if (video || expand === null || geometry === null) return null;
  const { box, at } = geometry;
  return (
    // The viewport overlay draws the source at this same fixed location.
    <div
      data-testid='mini-tool-expand-cover'
      className='pointer-events-none absolute'
      style={{ left: at.x, top: at.y, width: box.width, height: box.height, ...checkerboardStyle(handleScale(zoom), { x: 0, y: 0 }) }}
    />
  );
}
