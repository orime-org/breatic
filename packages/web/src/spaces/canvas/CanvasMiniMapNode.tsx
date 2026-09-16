// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One node as the minimap paints it.
 *
 * Every node but a note is drawn exactly as the library's own node draws it.
 * A note is drawn at a fixed patch of the board instead, because a pin's rect
 * is not a measure of the board: it holds 28 SCREEN pixels, so in the flow
 * coordinates this map paints in it is `28 / zoom` — at 10% zoom that is 280,
 * the size of an image node. Zooming out to survey the board is exactly when
 * a reader looks at this map, and it was exactly when every note swelled to
 * look like a picture.
 */

import { MiniMapNode, useStore, type MiniMapNodeProps } from '@xyflow/react';
import * as React from 'react';

import { PIN_SCREEN_SIZE } from '@web/spaces/canvas/annotation/pin-geometry';

/**
 * Draw one node on the minimap.
 * @param props - The rect and paint settings the minimap computed.
 * @returns The node's rectangle.
 */
export function CanvasMiniMapNode(props: MiniMapNodeProps): React.JSX.Element {
  const isNote = useStore(
    (s) => s.nodeLookup.get(props.id)?.type === 'annotation',
  );
  if (!isNote) return <MiniMapNode {...props} />;
  // `x`/`y` are the node's absolute position, which for a pin is already the
  // top-left its origin `[0, 1]` puts above the point it marks. Keeping the
  // bottom edge there keeps the patch on that point at every zoom.
  return (
    <MiniMapNode
      {...props}
      y={props.y + props.height - PIN_SCREEN_SIZE}
      width={PIN_SCREEN_SIZE}
      height={PIN_SCREEN_SIZE}
    />
  );
}
