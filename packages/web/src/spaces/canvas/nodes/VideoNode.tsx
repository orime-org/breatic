// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import type { VideoNodeData } from '@web/spaces/canvas/types/node';
import { NodeShell } from '@web/spaces/canvas/nodes/_shared/NodeShell';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';

interface VideoNodeProps {
  data: VideoNodeData;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
}

/**
 * Video node — native <video> element with a cover poster. Heavier
 * playback affordances (scrub, hot-key, picture-in-picture trigger)
 * arrive in a later polish PR.
 * @param root0 - Video node props.
 * @param root0.data - Video node payload (asset URL, cover poster, status, optional error message).
 * @param root0.selected - Whether the node is selected, driving the selection ring.
 * @param root0.locked - Whether the node is locked, showing the lock indicator.
 * @param root0.onActivate - Called from the empty-state placeholder to open the generate/load popover.
 * @returns The video node element (placeholder or native video player).
 */
export function VideoNode({
  data,
  selected,
  locked,
  onActivate,
}: VideoNodeProps): React.JSX.Element {
  const hasContent = Boolean(data.url);
  return (
    <NodeShell
      status={data.status}
      selected={selected}
      locked={locked}
      className='w-72'
      testId='video-node'
    >
      <NodeContent
        status={data.status}
        errorMessage={data.errorMessage}
        hasContent={hasContent}
        placeholder={
          <NodePlaceholder modality='video' onActivate={onActivate} />
        }
        content={
          // eslint-disable-next-line jsx-a11y/media-has-caption -- user-uploaded video asset; the upload flow does not produce a caption track. Add a <track> when caption authoring lands.
          <video
            controls
            src={data.url}
            poster={data.coverUrl}
            data-testid='video-node-video'
            className='block w-full rounded-[var(--radius-content-sm)]'
          />
        }
      />
    </NodeShell>
  );
}
