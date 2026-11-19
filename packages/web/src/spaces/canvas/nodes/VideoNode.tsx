// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { classifyVideoSourceLedgerFailure } from '@breatic/shared';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { useCanvasActions } from '@web/spaces/canvas/canvas-actions';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { useResolvedVideoPresentation } from '@web/spaces/canvas/video-presentation/use-resolved-video-presentation';
import { createVideoPresentationRecovery } from '@web/spaces/canvas/video-presentation/video-presentation-recovery';
import { Button } from '@web/components/ui/button';
import type { PresentedMediaFrame } from '@web/spaces/canvas/video-presentation/types';
import type { FrameMode, MediaPlayerProps, MediaPlayerVideoSnapshot } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';
import { useTranslation } from '@web/i18n/use-translation';

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
  const client = useQueryClient();
  const recovery = React.useMemo(() => createVideoPresentationRecovery(client, { projectId, canonicalURL: player.src, active: true }), [client, projectId, player.src]);
  const identity = JSON.stringify([projectId, player.src]);
  const currentIdentity = React.useRef(identity);
  currentIdentity.current = identity;
  const mounted = React.useRef(false);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [rendererFailure, setRendererFailure] = React.useState<{ identity: string; error: string } | null>(null);
  const [retrying, setRetrying] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  // A local retry gives the existing leaf a fresh resource lifetime while the
  // player, its volume and the canonical descriptor remain owned in place.
  const presentedSource = React.useMemo(() => { void attempt; return source === null ? null : { ...source }; }, [source, attempt]);
  const localFailure = rendererFailure?.identity === identity ? rendererFailure.error : null;
  const t = useTranslation();
  /**
   * Publishes only this canonical node attachment, including unresolved failure.
   * @param snapshot - Actual resource and React-owned overlay host.
   * @throws {never} Never.
   */
  const onBinding = React.useCallback((snapshot: MediaPlayerVideoSnapshot): void => {
    if (snapshot.status === 'failed') setRendererFailure((held) => held?.identity === identity && held.error === snapshot.error ? held : { identity, error: snapshot.error ?? 'renderer-failed' });
    else if (snapshot.status === 'ready') setRendererFailure((held) => held?.identity === identity ? null : held);
    const notice = { ...snapshot, sourceBinding: query.data?.sourceBinding };
    actions.onVideoBinding?.(nodeId, player.src, failure === null || snapshot.binding !== null ? notice : { ...notice, status: 'failed', error: failure });
  }, [actions, nodeId, player.src, failure, query.data?.sourceBinding, identity]);
  /**
   * Forwards a committed draw synchronously without treating native time as a frame.
   * @param frame - The actual canonical drawable frame and its epochs.
   * @throws {never} The canvas consumer owns pixel-read failures.
   */
  const onFrame = React.useCallback((frame: PresentedMediaFrame): void => actions.onVideoFrame?.(nodeId, player.src, frame), [actions, nodeId, player.src]);
  const { openFrameTool } = actions;
  // The camera menu opens Extract frames on this node (tools design §4 camera menu); viewers get none.
  const onPickFrame = React.useMemo(() => openFrameTool === undefined ? undefined : (mode: FrameMode): void => openFrameTool(nodeId, mode), [openFrameTool, nodeId]);
  /**
   * Restarts only this source after its existing recovery operation completes.
   * @throws {never} The source reports errors; this caller resets its wait state.
   */
  async function retry(): Promise<void> {
    if (!mounted.current || currentIdentity.current !== identity) return;
    setRetrying(identity);
    try {
      await recovery.recover(failure === null ? 'renderer' : 'source');
      if (!mounted.current || currentIdentity.current !== identity) return;
      setRendererFailure(null);
      if (source !== null) setAttempt((value) => value + 1);
    } catch {
      // Keep the failure visible; repair failures were already reported at source.
    } finally {
      if (mounted.current && currentIdentity.current === identity) setRetrying(null);
    }
  }
  return <MediaPlayer {...player} videoSource={presentedSource} onVideoBinding={onBinding} onPresentedFrame={onFrame} onPickFrame={onPickFrame}>
    {failure === null && localFailure === null ? null : <div className='pointer-events-auto absolute inset-0 z-20 grid place-content-center justify-items-center gap-2 bg-card p-3 text-center'>
      <p className='text-xs text-status-error-foreground'>{t('canvas.miniTool.videoUI.mediaError')}</p>
      {/* A content failure comes out the same on every rerun, so it offers no Retry (design §10.6 failure classes). */}
      {localFailure === null && failure !== null && classifyVideoSourceLedgerFailure(failure) === 'content' ? null
        : <Button variant='outline' size='sm' className='nodrag nokey' loading={retrying === identity} onClick={() => { void retry(); }}>{t('canvas.miniTool.videoUI.retryPreview')}</Button>}
    </div>}
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
            <Player
              ref={player}
              projectId={projectId}
              nodeId={nodeId ?? ''}
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
