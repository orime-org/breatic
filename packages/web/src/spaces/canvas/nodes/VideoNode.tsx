// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { useCanvasActions } from '@web/spaces/canvas/canvas-actions';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { useResolvedVideoPresentation } from '@web/spaces/canvas/video-presentation/use-resolved-video-presentation';
import type { PresentedMediaFrame } from '@web/spaces/canvas/video-presentation/types';
import type { MediaPlayerProps, MediaPlayerVideoSnapshot } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';
import { useTranslation } from '@web/i18n/use-translation';

import type { VideoNodeView } from '@web/data/yjs/node-view';
import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodeMediaInset } from '@web/spaces/canvas/nodes/_shared/NodeMediaInset';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';
import { MediaPlayer } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';
import { useZoomedPastPreview } from '@web/spaces/canvas/nodes/_shared/preview-zoom';
import { useNodeResolution } from '@web/spaces/canvas/nodes/_shared/use-node-resolution';
import { useCanvasSession } from '@web/spaces/canvas/canvas-context';

/**
 * Resolves one project-authorized source through the existing account query client.
 * @param props - Canonical player props and this host identity.
 * @returns The existing player with its actual presentation owner.
 * @throws {never} Query and renderer failures remain visible on the node.
 */
function ResolvedNodeVideo(props: MediaPlayerProps & { nodeId: string; projectId: string }): React.JSX.Element {
  const { nodeId, projectId, ...player } = props;
  const actions = useCanvasActions();
  const { source, failure, query } = useResolvedVideoPresentation(projectId, player.src, true);
  const t = useTranslation();
  /**
   * Publishes only this canonical node attachment, including unresolved failure.
   * @param snapshot - Actual resource and React-owned overlay host.
   * @throws {never} Never.
   */
  const onBinding = React.useCallback((snapshot: MediaPlayerVideoSnapshot): void => {
    const notice = { ...snapshot, sourceBinding: query.data?.sourceBinding };
    actions.onVideoBinding?.(nodeId, player.src, failure === null || snapshot.binding !== null ? notice : { ...notice, status: 'failed', error: failure });
  }, [actions, nodeId, player.src, failure, query.data?.sourceBinding]);
  /**
   * Forwards a committed draw synchronously without treating native time as a frame.
   * @param frame - The actual canonical drawable frame and its epochs.
   * @throws {never} The canvas consumer owns pixel-read failures.
   */
  const onFrame = React.useCallback((frame: PresentedMediaFrame): void => actions.onVideoFrame?.(nodeId, player.src, frame), [actions, nodeId, player.src]);
  return <MediaPlayer {...player} videoSource={source} onVideoBinding={onBinding} onPresentedFrame={onFrame}>
    {failure === null ? null : <p className='pointer-events-none absolute inset-0 grid place-content-center bg-card p-3 text-center text-xs text-status-error-foreground'>{t('canvas.miniTool.videoUI.mediaError')}</p>}
  </MediaPlayer>;
}

interface VideoNodeProps {
  data: VideoNodeView;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
  onRename?: (name: string) => void;
}

/**
 * Video node — renders the unified {@link MediaPlayer} (native `<video>` +
 * cover poster + a scrubber, volume and fullscreen control bar, zero
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
  const nodeId = React.useContext(NodeIdContext);
  const { projectId } = useCanvasContext();
  const Player = projectId && nodeId ? ResolvedNodeVideo : MediaPlayer;
  const { resolution, setResolution } = useNodeResolution(data.content, data.width, data.height);
  const fullPoster = useZoomedPastPreview(data.coverUrl);
  // Subscribe to the BOOLEAN, not the session object: this node re-renders
  // only when the answer flips, not on every change to an unrelated pick.
  const focusPicking = useCanvasSession(
    (s) => s.pickSession?.purpose === 'focus',
  );
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
          <NodeMediaInset>
            <Player
              projectId={projectId}
              nodeId={nodeId ?? ''}
              modality='video'
              src={data.content ?? ''}
              poster={data.coverUrl}
              fullPoster={fullPoster}
              size={
                typeof data.width === 'number' && typeof data.height === 'number'
                  ? { width: data.width, height: data.height }
                  : undefined
              }
              duration={data.duration}
              onDimensions={setResolution}
              controlsHidden={focusPicking}
            />
          </NodeMediaInset>
        }
      />
    </ContentNodeFrame>
  );
});
