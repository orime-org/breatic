// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Box } from 'lucide-react';
import * as React from 'react';

import type { ThreeDNodeView } from '@web/spaces/canvas/types/node-view';
import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';

interface ThreeDNodeProps {
  data: ThreeDNodeView;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
  onRename?: (name: string) => void;
}

/**
 * 3D node — placeholder body that shows the bound .glb / .gltf model
 * URL. PR 14 ships the structural slot; the real renderer (React
 * Three Fiber Canvas + OrbitControls + suspense loader) lands during
 * the M3+ media polish PR.
 * @param root0 - 3D node props.
 * @param root0.data - 3D node payload (model URL, status, optional error message).
 * @param root0.selected - Whether the node is selected, driving the selection ring.
 * @param root0.locked - Whether the node is locked, showing the lock indicator.
 * @param root0.onActivate - Called from the empty-state placeholder to open the generate/load popover.
 * @param root0.onRename - Commit a rename of this node's name (pre-bound to the node id by the canvas).
 * @returns The 3D node element (placeholder or model URL stub).
 */
export const ThreeDNode = React.memo(function ThreeDNode({
  data,
  selected,
  locked,
  onActivate,
  onRename,
}: ThreeDNodeProps): React.JSX.Element {
  const hasContent = Boolean(data.content);
  return (
    <ContentNodeFrame
      modality='3d'
      name={data.name}
      status={data.status}
      selected={selected}
      locked={locked}
      onRename={onRename}
      testId='three-d-node'
    >
      <NodeContent
        status={data.status}
        errorMessage={data.errorMessage}
        hasContent={hasContent}
        placeholder={
          <NodePlaceholder modality='3d' onActivate={onActivate} />
        }
        content={
          <div
            data-testid='three-d-node-stub'
            className='flex h-32 w-full flex-col items-center justify-center gap-1 bg-muted/40 text-xs text-muted-foreground'
          >
            <Box className='h-5 w-5 opacity-60' aria-hidden='true' />
            <span className='truncate px-2'>{data.content}</span>
          </div>
        }
      />
    </ContentNodeFrame>
  );
});
