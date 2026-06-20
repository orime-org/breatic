// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import type { ImageNodeView } from '@web/spaces/canvas/types/node-view';
import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';

interface ImageNodeProps {
  data: ImageNodeView;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
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
 * @returns The image node element (placeholder or rendered image).
 */
export function ImageNode({
  data,
  selected,
  locked,
  onActivate,
  onRename,
}: ImageNodeProps): React.JSX.Element {
  const hasContent = Boolean(data.content);
  return (
    <ContentNodeFrame
      modality='image'
      name={data.name}
      status={data.status}
      selected={selected}
      locked={locked}
      onRename={onRename}
      testId='image-node'
    >
      <NodeContent
        status={data.status}
        errorMessage={data.errorMessage}
        hasContent={hasContent}
        placeholder={
          <NodePlaceholder modality='image' onActivate={onActivate} />
        }
        content={
          <img
            src={data.content ?? ''}
            alt=''
            data-testid='image-node-img'
            className='block h-auto w-full rounded-[var(--radius-content-sm)]'
          />
        }
      />
    </ContentNodeFrame>
  );
}
