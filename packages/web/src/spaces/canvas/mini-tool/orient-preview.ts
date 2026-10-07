// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Orientation } from '@web/spaces/canvas/focus/crop-export';
import { useCanvasSession } from '@web/spaces/canvas/canvas-context';

/**
 * The CSS transform that previews an orientation on the node's picture
 * (inner#888 §7.4). A quarter turn also shrinks the picture by the shorter
 * over the longer side, so the whole of it stays inside the card; the flips
 * apply before the turn, the order the export draws in.
 * @param orientation - The turns and flips.
 * @param width - The picture's width.
 * @param height - The picture's height.
 * @returns The transform, or undefined when the picture is upright.
 */
export function orientPreviewTransform(
  orientation: Orientation,
  width: number,
  height: number,
): string | undefined {
  const turns = ((orientation.turns % 4) + 4) % 4;
  if (turns === 0 && !orientation.flipX && !orientation.flipY) return undefined;
  const fit = turns % 2 === 1 ? Math.min(width / height, height / width) : 1;
  return `rotate(${turns * 90}deg) scale(${fit}) scale(${orientation.flipX ? -1 : 1}, ${orientation.flipY ? -1 : 1})`;
}

/**
 * The orientation a rotate & flip panel open on this node is previewing.
 * @param nodeId - The node, or null outside one.
 * @returns The draft orientation, or undefined when no such panel is open on it.
 */
export function useOrientPreview(nodeId: string | null): Orientation | undefined {
  return useCanvasSession((s) =>
    s.panelKind === 'miniTool' && s.panelHostId === nodeId && nodeId !== null
      ? (s.miniTool?.params.orient as Orientation | undefined)
      : undefined,
  );
}
