// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useStore } from '@xyflow/react';
import * as React from 'react';

import { defaultParamsOf, miniToolById } from '@breatic/shared/mini-tools';

import { useCanvasSession } from '@web/spaces/canvas/canvas-context';
import { handleScale } from '@web/spaces/canvas/crop/crop-geometry';
import { useMediaGeometry } from '@web/spaces/canvas/crop/media-geometry';

interface NodeGridLayerProps {
  /** The node this layer belongs to. */
  nodeId: string;
  /** The node's outer positioned wrapper; see `NodeCropLayer`. */
  wrapper: HTMLElement | null;
}

/**
 * The lines a grid tool cuts the picture along, laid over the node's picture
 * while that tool's panel is open on it (inner#1303 §6.4). They follow the
 * rows and columns in the draft and take no input.
 * @param root0 - Component props.
 * @param root0.nodeId - The node.
 * @param root0.wrapper - The node's outer wrapper.
 * @returns The layer, or null when no grid tool is open on this node.
 */
export function NodeGridLayer({ nodeId, wrapper }: NodeGridLayerProps): React.JSX.Element | null {
  const draft = useCanvasSession((s) =>
    s.panelKind === 'miniTool' && s.panelHostId === nodeId && s.pickSession === null ? s.miniTool : null,
  );
  const spec = draft === null ? undefined : miniToolById(draft.toolId);
  const grid = spec?.outputLayout === 'grid' ? spec : undefined;
  const geometry = useMediaGeometry(wrapper, grid !== undefined);
  // The lines counter the zoom, as the crop frame's do.
  const scale = handleScale(useStore((s) => s.transform[2]));
  if (grid === undefined || geometry === null || draft === null) return null;
  const params = { ...defaultParamsOf(grid), ...draft.params };
  const rows = params.rows as number;
  const cols = params.cols as number;
  const line = 'absolute bg-background outline outline-foreground';
  return (
    <div
      data-testid='mini-tool-grid-layer'
      className='pointer-events-none absolute'
      style={{ left: geometry.at.x, top: geometry.at.y, width: geometry.box.width, height: geometry.box.height }}
    >
      {Array.from({ length: cols - 1 }, (_, i) => (
        <div
          key={`c${i}`}
          data-testid='mini-tool-grid-col'
          className={`${line} inset-y-0`}
          style={{ left: `${((i + 1) * 100) / cols}%`, width: scale, outlineWidth: scale }}
        />
      ))}
      {Array.from({ length: rows - 1 }, (_, i) => (
        <div
          key={`r${i}`}
          data-testid='mini-tool-grid-row'
          className={`${line} inset-x-0`}
          style={{ top: `${((i + 1) * 100) / rows}%`, height: scale, outlineWidth: scale }}
        />
      ))}
    </div>
  );
}
