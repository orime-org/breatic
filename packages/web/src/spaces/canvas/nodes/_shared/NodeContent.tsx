// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { PLANNED_BODY_MIN_PX } from '@web/spaces/canvas/group-geometry';
import { NodeMediaInset } from '@web/spaces/canvas/nodes/_shared/NodeMediaInset';
import { NodeUploadMarkOverlay } from '@web/spaces/canvas/nodes/_shared/NodeUploadMarkOverlay';

interface NodeContentProps {
  hasContent: boolean;
  placeholder: React.ReactNode;
  content: React.ReactNode;
  /** The picture's pixel size an empty node already knows (a tool's planned result). */
  emptySize?: { width: number; height: number } | undefined;
}

/**
 * Switches between placeholder and content on whether a content payload
 * exists. A node shows no task state (inner#888 §7.8): what its tasks did is
 * the counts column beside it and the task list, so a running task leaves the
 * body on whatever it already holds and a failed one leaves it empty.
 * Type-node bodies pass their modality-specific renderers.
 * @param root0 - Node content props.
 * @param root0.hasContent - Whether a content payload exists.
 * @param root0.placeholder - Empty-state node rendered when the node holds nothing.
 * @param root0.content - Modality-specific body rendered when the node holds something.
 * @param root0.emptySize - The picture's size an empty node already knows.
 * @returns The branch element for the current node state.
 */
export function NodeContent({
  hasContent,
  placeholder,
  content,
  emptySize,
}: NodeContentProps): React.JSX.Element {
  // An empty node fills a fixed h-48 box so every empty node is the same size
  // regardless of modality; a filled node grows to its content's real height.
  // An empty node that already knows its picture's size (a tool's result,
  // inner#1303 §6.7) holds the box that picture will take, inset as it will
  // be, so it is laid out and framed at the height it will have. The
  // uploader's mark lies over content; an empty node's placeholder draws it in
  // place of its call to action.
  if (hasContent) {
    return (
      <>
        {content}
        <NodeUploadMarkOverlay />
      </>
    );
  }
  if (emptySize !== undefined) {
    return (
      <NodeMediaInset>
        <div
          data-testid='node-content-empty'
          // The width is the node's: with an auto width the minimum height
          // would widen the box through the ratio instead of heightening it.
          className='w-full'
          style={{ aspectRatio: `${emptySize.width} / ${emptySize.height}`, minHeight: PLANNED_BODY_MIN_PX }}
        >
          {placeholder}
        </div>
      </NodeMediaInset>
    );
  }
  return (
    <div data-testid='node-content-empty' className='h-48'>
      {placeholder}
    </div>
  );
}
