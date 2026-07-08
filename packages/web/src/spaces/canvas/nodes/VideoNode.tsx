// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import type { VideoNodeView } from '@web/spaces/canvas/types/node-view';
import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';
import { MediaPlayer } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';
import { useNodeResolution } from '@web/spaces/canvas/nodes/_shared/useNodeResolution';

interface VideoNodeProps {
  data: VideoNodeView;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
  /** Retry a failed upload (error state), pre-bound to this node (#1609 P4). */
  onRetryUpload?: () => void;
  onRename?: (name: string) => void;
}

/**
 * Video node — renders the unified {@link MediaPlayer} (native `<video>` +
 * cover poster + a scrubber, volume and fullscreen control bar, zero
 * third-party player dependency).
 * @param root0 - Video node props.
 * @param root0.data - Video node payload (asset URL, cover poster, status, optional error message).
 * @param root0.selected - Whether the node is selected, driving the selection ring.
 * @param root0.locked - Whether the node is locked, showing the lock indicator.
 * @param root0.onActivate - Called from the empty-state placeholder to open the generate/load popover.
 * @param root0.onRetryUpload - Retry a failed upload from the session stash (#1609 P4); absent hides the Retry button.
 * @param root0.onRename - Commit a rename of this node's name (pre-bound to the node id by the canvas).
 * @returns The video node element (placeholder or native video player).
 */
export const VideoNode = React.memo(function VideoNode({
  data,
  selected,
  locked,
  onActivate,
  onRetryUpload,
  onRename,
}: VideoNodeProps): React.JSX.Element {
  const hasContent = Boolean(data.content);
  const { resolution, setResolution } = useNodeResolution(data.content);
  return (
    <ContentNodeFrame
      modality='video'
      name={data.name}
      status={data.status}
      selected={selected}
      locked={locked}
      onRename={onRename}
      testId='video-node'
      resolution={resolution}
    >
      <NodeContent
        status={data.status}
        errorMessage={data.errorMessage}
        onRetry={onRetryUpload}
        hasContent={hasContent}
        placeholder={
          <NodePlaceholder modality='video' onActivate={onActivate} />
        }
        content={
          <MediaPlayer
            modality='video'
            src={data.content ?? ''}
            poster={data.coverUrl}
            onDimensions={setResolution}
          />
        }
      />
    </ContentNodeFrame>
  );
});
