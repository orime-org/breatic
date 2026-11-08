// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { TimelineWebAnimationClip } from '@breatic/shared';
import { webAnimationDurationFrames, type TimelineExecutionInput } from '@breatic/shared/space-content';

import { Skeleton } from '@web/components/ui/skeleton';
import { Slider } from '@web/components/ui/slider';
import { useTranslation } from '@web/i18n/use-translation';
import { formatTimelineTimecode } from '@web/spaces/timeline/timeline-timecode';
import { UNDRAWN_PLAYER, usePlayerDefined, useWebInstanceDrawn } from '@web/spaces/timeline/TimelineWebPreview';
import { useWebAnimationPreviewUrl } from '@web/spaces/timeline/use-web-animation-preview-url';
import { createWebAnimationHost, type WebAnimationPlayerElement, type WebInstanceState } from '@web/spaces/timeline/web-animation-host';

/** One succeeded execution's result. */
interface TimelineWebResultPreviewProps { projectId: string; executionId: string; sourceVersionId: string; input: TimelineExecutionInput }

/**
 * A finished result in the execution list, scrubbed by its own slider through the same frame-ready bridge as the
 * Timeline preview (inner#1711 design §8). Its page is sandboxed and takes no clicks.
 * @param props - The result.
 * @param props.projectId - The Project its address is read through.
 * @param props.executionId - The execution, standing in for a copy's id.
 * @param props.sourceVersionId - The source version.
 * @param props.input - What the execution accepted: its aspect, length and frame rate.
 * @returns The preview.
 * @throws {never} Never.
 */
export function TimelineWebResultPreview({ projectId, executionId, sourceVersionId, input }: TimelineWebResultPreviewProps): React.JSX.Element {
  const t = useTranslation();
  const preview = useWebAnimationPreviewUrl(projectId, sourceVersionId);
  const defined = usePlayerDefined(true);
  const [element, setElement] = React.useState<HTMLElement | null>(null);
  const [frame, setFrame] = React.useState(0);
  const position = React.useRef(0);
  const durationFrames = webAnimationDurationFrames(input);
  const { fps } = input;
  const clip = React.useMemo((): TimelineWebAnimationClip => ({
    id: executionId, trackId: '', kind: 'web-animation', contentBinding: { baseSourceResultId: sourceVersionId, operationId: null },
    startFrame: 0, sourceInFrame: 0, durationFrames, rate: { num: 1, den: 1 }, gain: 1, mute: false, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  }), [executionId, sourceVersionId, durationFrames]);
  const [state, setState] = React.useState<WebInstanceState | undefined>(undefined);
  const [host] = React.useState(() => {
    const created = createWebAnimationHost({
      frame: () => position.current, timelineFps: () => fps, loadTimeoutMs: () => undefined,
      // The one instance is keyed by its source version; its state decides whether the picture is drawn yet.
      onChange: () => setState(created.states().values().next().value),
    });
    return created;
  });
  const drawn = useWebInstanceDrawn(state);
  React.useEffect(() => {
    /**
     * Hand a window message to the host.
     * @param event - The message.
     * @throws {never} Never.
     */
    const receive = (event: MessageEvent): void => { host.receive(event); };
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      host.dispose();
    };
  }, [host]);
  React.useEffect(() => {
    host.sync(defined && element !== null ? [{ key: sourceVersionId, clip, fps, player: element as WebAnimationPlayerElement }] : []);
  }, [host, defined, element, sourceVersionId, clip, fps]);
  const scrub = React.useCallback((value: number[]): void => {
    position.current = value[0] ?? 0;
    setFrame(position.current);
    host.reposition();
  }, [host]);
  const value = React.useMemo(() => [frame], [frame]);
  const style = React.useMemo(() => ({ aspectRatio: input.aspect.replace(':', ' / ') }), [input.aspect]);
  const playerStyle = React.useMemo(() => ({ pointerEvents: 'none' as const, ...(drawn ? {} : UNDRAWN_PLAYER) }), [drawn]);
  return <div className='flex flex-col gap-1.5'>
    <div className='relative mx-auto max-h-48 w-full max-w-full overflow-hidden rounded-chrome border border-border bg-muted' style={style}>
      {!drawn && <Skeleton className='absolute inset-0 size-full rounded-none' />}
      {preview.url !== null && <hyperframes-player ref={setElement} src={preview.url} sandbox-origin='' disable-click-to-play='' data-web-state={state ?? 'loading'}
        className='absolute inset-0 size-full' style={playerStyle} />}
    </div>
    <div className='flex items-center gap-2'>
      <Slider aria-label={t('timeline.seek')} value={value} onValueChange={scrub} min={0} max={Math.max(1, durationFrames - 1)} step={1} className='min-w-0 flex-1' />
      <span className='shrink-0 text-2xs tabular-nums text-muted-foreground'>{formatTimelineTimecode(frame, fps)}</span>
    </div>
  </div>;
}
