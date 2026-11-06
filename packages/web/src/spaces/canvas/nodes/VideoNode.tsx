// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import type { VideoNodeView } from '@web/data/yjs/node-view';
import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodeMediaInset } from '@web/spaces/canvas/nodes/_shared/NodeMediaInset';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';
import { MediaPlayer, type MediaPlayerHandle } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';
import { useMediaFullscreen } from '@web/spaces/canvas/nodes/_shared/use-media-fullscreen';
import { useZoomedPastPreview } from '@web/spaces/canvas/nodes/_shared/preview-zoom';
import { useNodeResolution } from '@web/spaces/canvas/nodes/_shared/use-node-resolution';
import { useCanvasSession } from '@web/spaces/canvas/canvas-context';

interface VideoNodeProps {
  data: VideoNodeView;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
  onRename?: (name: string) => void;
}

/**
 * Video node — renders the unified {@link MediaPlayer} (native `<video>` +
 * cover poster + a scrubber and volume control bar, zero
 * third-party player dependency).
 * @param root0 - Video node props.
 * @param root0.data - Video node payload (asset URL, cover poster).
 * @param root0.selected - Whether the node is selected, driving the selection ring.
 * @param root0.locked - Whether the node is locked, showing the lock indicator.
 * @param root0.onActivate - Called from the empty-state placeholder to open the generate/load popover.
 * @param root0.onRename - Commit a rename of this node's name (pre-bound to the node id by the canvas).
 * @returns The video node element (placeholder or native video player).
 */
export const VideoNode = React.memo(function VideoNode({
  data,
  selected,
  locked,
  onActivate,
  onRename,
}: VideoNodeProps): React.JSX.Element {
  const hasContent = Boolean(data.content);
  const { resolution, setResolution } = useNodeResolution(data.content, data.width, data.height);
  const fullPoster = useZoomedPastPreview(data.coverUrl);
  // Subscribe to the BOOLEAN, not the session object: this node re-renders
  // only when the answer flips, not on every change to an unrelated pick.
  const focusPicking = useCanvasSession(
    (s) => s.pickSession?.purpose === 'focus',
  );
  const player = React.useRef<MediaPlayerHandle>(null);
  const fullscreen = useMediaFullscreen({ name: data.name ?? '', currentSrc: data.content, player });
  const size =
    typeof data.width === 'number' && typeof data.height === 'number'
      ? { width: data.width, height: data.height }
      : undefined;
  return (
    <ContentNodeFrame
      modality='video'
      name={data.name}
      selected={selected}
      locked={locked}
      onRename={onRename}
      testId='video-node'
      resolution={resolution}
    >
      <NodeContent
        hasContent={hasContent}
        placeholder={
          <NodePlaceholder modality='video' onActivate={onActivate} />
        }
        content={
          <NodeMediaInset
            onFullscreen={() =>
              fullscreen.open({ kind: 'video', src: data.content ?? '', poster: data.coverUrl, size })
            }
          >
            <MediaPlayer
              ref={player}
              modality='video'
              src={data.content ?? ''}
              poster={data.coverUrl}
              fullPoster={fullPoster}
              size={size}
              duration={data.duration}
              onDimensions={setResolution}
              controlsHidden={focusPicking}
            />
            {fullscreen.layer}
          </NodeMediaInset>
        }
      />
    </ContentNodeFrame>
  );
});
