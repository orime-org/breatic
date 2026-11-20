// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import type { TimelineWebAnimationClip } from '@breatic/shared';
import { webAnimationDurationFrames } from '@breatic/shared/space-content';

import { Skeleton } from '@web/components/ui/skeleton';
import { UNDRAWN_PLAYER, usePlayerDefined, useWebInstanceDrawn } from '@web/spaces/timeline/TimelineWebPreview';
import { useTimelineLimits } from '@web/spaces/timeline/use-timeline-limits';
import { useWebAnimationPreviewUrl } from '@web/spaces/timeline/use-web-animation-preview-url';
import { createWebAnimationHost, type WebAnimationPlayerElement, type WebInstanceState } from '@web/spaces/timeline/web-animation-host';
import { TIMELINE_DEFAULT_PLACEMENT } from '@web/data/yjs/timeline-edit';
import { PreviewUnavailable } from '@web/spaces/web-animation/motion-parts';

/** One succeeded execution's result, and the frame the Space's play bar is on. */
interface MotionResultPlayerProps {
  projectId: string;
  executionId: string;
  sourceVersionId: string;
  input: { durationSeconds: number; fps: { num: number; den: number } };
  /** The frame to show, from the play bar. */
  frame: number;
}

/**
 * A finished result in the Motion Space's preview (#1490 design §7.1), driven to the play bar's frame through the same
 * frame-ready bridge as the Timeline preview (inner#1711 design §8), under the same player load timeout. It fills the
 * frame it is placed in. Its page is sandboxed and takes no clicks; a refused address, a player module that failed to
 * load or a page that never answered shows unavailable with a retry instead of the skeleton.
 * @param props - The result.
 * @param props.projectId - The Project its address is read through.
 * @param props.executionId - The execution, standing in for a copy's id.
 * @param props.sourceVersionId - The source version.
 * @param props.input - What the execution accepted: its length and frame rate.
 * @param props.frame - The frame to show.
 * @returns The player.
 * @throws {never} Never.
 */
export function MotionResultPlayer({ projectId, executionId, sourceVersionId, input, frame }: MotionResultPlayerProps): React.JSX.Element {
  const preview = useWebAnimationPreviewUrl(projectId, sourceVersionId);
  const player = usePlayerDefined(true);
  const { defined } = player;
  const loadTimeoutMs = useTimelineLimits(projectId)?.webAnimation.playerLoadTimeoutMs;
  const latestTimeoutMs = React.useRef(loadTimeoutMs);
  latestTimeoutMs.current = loadTimeoutMs;
  const [element, setElement] = React.useState<HTMLElement | null>(null);
  const position = React.useRef(frame);
  const durationFrames = webAnimationDurationFrames(input);
  const { fps } = input;
  // The Space shows result after result in this one host; each maps the play bar with its own frame rate.
  const latestFps = React.useRef(fps);
  latestFps.current = fps;
  const clip = React.useMemo((): TimelineWebAnimationClip => ({
    id: executionId, trackId: '', kind: 'web-animation', contentBinding: { baseSourceResultId: sourceVersionId, operationId: null },
    startFrame: 0, sourceInFrame: 0, durationFrames, ...TIMELINE_DEFAULT_PLACEMENT,
  }), [executionId, sourceVersionId, durationFrames]);
  const [state, setState] = React.useState<WebInstanceState | undefined>(undefined);
  const [host] = React.useState(() => {
    const created = createWebAnimationHost({
      frame: () => position.current, timelineFps: () => latestFps.current, loadTimeoutMs: () => latestTimeoutMs.current,
      // The one instance is keyed by its source version; its state decides whether the picture is drawn yet.
      onChange: () => setState(created.states().values().next().value),
    });
    return created;
  });
  const drawn = useWebInstanceDrawn(state);
  React.useEffect(() => host.listen(), [host]);
  React.useEffect(() => {
    host.sync(defined && element !== null ? [{ key: sourceVersionId, clip, fps, role: 'visible', player: element as WebAnimationPlayerElement }] : []);
    // A detached or newly attached instance changes state without the host saying so; a timeout arriving after the
    // instance attached starts its wait.
    setState(host.states().get(sourceVersionId));
  }, [host, defined, element, sourceVersionId, clip, fps, loadTimeoutMs]);
  const { refresh } = preview;
  const unavailable = preview.failed || player.failed || state === 'failed';
  const retry = React.useCallback((): void => {
    player.retry();
    refresh();
    host.retry(sourceVersionId);
    // The host reports only the changes it makes on its own.
    setState(host.states().get(sourceVersionId));
  }, [player, refresh, host, sourceVersionId]);
  React.useEffect(() => {
    position.current = frame;
    host.reposition();
  }, [host, frame]);
  const playerStyle = React.useMemo(() => ({ pointerEvents: 'none' as const, ...(drawn ? {} : UNDRAWN_PLAYER) }), [drawn]);
  return <div className='absolute inset-0 overflow-hidden rounded-chrome bg-muted'>
    {unavailable ? <PreviewUnavailable onRetry={retry} /> : !drawn && <Skeleton className='absolute inset-0 size-full rounded-none' />}
    {preview.url !== null && <hyperframes-player ref={setElement} src={preview.url} sandbox-origin='' disable-click-to-play='' data-web-state={state ?? 'loading'}
      className='absolute inset-0 size-full bg-transparent' style={playerStyle} />}
  </div>;
}
