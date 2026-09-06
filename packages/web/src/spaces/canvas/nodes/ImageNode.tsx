// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import type { ImageNodeView } from '@web/spaces/canvas/types/node-view';
import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodeMediaInset } from '@web/spaces/canvas/nodes/_shared/NodeMediaInset';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';
import { useNodeResolution } from '@web/spaces/canvas/nodes/_shared/useNodeResolution';

interface ImageNodeProps {
  data: ImageNodeView;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
  /** Open this node's task list on its failures (#186 §3.7.2). */
  onViewTasks?: () => void;
  onRename?: (name: string) => void;
}

/**
 * Image node — displays the bound image URL, or a placeholder when the
 * node is empty. Click-to-generate lives in the toolbar left zone (PR 7);
 * here we just render the asset.
 * @param root0 - Image node props.
 * @param root0.data - Image node payload (asset URL, status, optional error message).
 * @param root0.selected - Whether the node is selected, driving the selection ring.
 * @param root0.locked - Whether the node is locked, showing the lock indicator.
 * @param root0.onActivate - Called from the empty-state placeholder to open the generate/load popover.
 * @param root0.onRename - Commit a rename of this node's name (pre-bound to the node id by the canvas).
 * @param root0.onViewTasks - Open this node's task list on its failures.
 * @returns The image node element (placeholder or rendered image).
 */
export const ImageNode = React.memo(function ImageNode({
  data,
  selected,
  locked,
  onActivate,
  onViewTasks,
  onRename,
}: ImageNodeProps): React.JSX.Element {
  const hasContent = Boolean(data.content);
  const { resolution, setResolution } = useNodeResolution(data.content);
  return (
    <ContentNodeFrame
      modality='image'
      name={data.name}
      status={data.status}
      selected={selected}
      locked={locked}
      onRename={onRename}
      testId='image-node'
      resolution={resolution}
    >
      <NodeContent
        onViewTasks={onViewTasks}
        status={data.status}
        errorMessage={data.errorMessage}
        hasContent={hasContent}
        placeholder={
          <NodePlaceholder modality='image' onActivate={onActivate} />
        }
        content={
          <NodeMediaInset>
            <img
              src={data.content ?? ''}
              alt=''
              // Offscreen nodes still mount once on canvas load (xyflow #3883,
              // see onlyRenderVisibleElements in CanvasSpace) — lazy defers
              // their fetch to viewport proximity (#1772).
              loading='lazy'
              decoding='async'
              data-testid='image-node-img'
              className='block h-auto w-full'
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setResolution({
                    width: img.naturalWidth,
                    height: img.naturalHeight,
                  });
                }
              }}
            />
          </NodeMediaInset>
        }
      />
    </ContentNodeFrame>
  );
});
