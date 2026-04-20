import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWavesurfer } from '@wavesurfer/react';

const formatTickTime = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const pickTickIntervalSeconds = (duration: number) => {
  const targetTickCount = 8;
  const rough = Math.max(1, duration / targetTickCount);
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return candidates.find((v) => v >= rough) ?? candidates[candidates.length - 1];
};

/** Horizontal gutter ≈ half of playhead hit strip (`w-3`); keeps 0%/100% under translateX(-50%) without wide side loss. */
const PLAYHEAD_EDGE_INSET_PX = 6;

/** Slider 0–100 → px/s; midpoint 50 == former fixed 18px/s. */
const TIMELINE_ZOOM_MIN_PX_PER_SEC = 4;
const TIMELINE_ZOOM_MAX_PX_PER_SEC = 32;

export type PlaybackTimelineSectionProps = {
  progressPct: number;
  duration: number;
  mediaSrc?: string;
  onProgressChange: (value: number) => void;
  /** 0 = most compressed, 100 = most stretched; scales ruler / waveform width. */
  timelineZoom: number;
};

const PlaybackTimelineSection: React.FC<PlaybackTimelineSectionProps> = ({
  progressPct,
  duration,
  mediaSrc,
  onProgressChange,
  timelineZoom,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const timelineOuterRef = useRef<HTMLDivElement | null>(null);
  const waveformRef = useRef<HTMLDivElement | null>(null);
  const playheadDraggingRef = useRef(false);
  const waveUrl = mediaSrc?.trim() ? mediaSrc : undefined;
  const [firstFrameUrl, setFirstFrameUrl] = useState<string>('');
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const zoomClamped = Math.min(100, Math.max(0, timelineZoom));
  const pixelsPerSecond =
    TIMELINE_ZOOM_MIN_PX_PER_SEC + (zoomClamped / 100) * (TIMELINE_ZOOM_MAX_PX_PER_SEC - TIMELINE_ZOOM_MIN_PX_PER_SEC);
  const timelineWidthPx = Math.max(660, Math.ceil(safeDuration * pixelsPerSecond));
  const timelineOuterMinWidthPx = timelineWidthPx + PLAYHEAD_EDGE_INSET_PX * 2;
  const majorStep = useMemo(() => pickTickIntervalSeconds(safeDuration), [safeDuration]);
  const majorTicks = useMemo(() => {
    if (safeDuration <= 0) return [0];
    const values: number[] = [];
    for (let t = 0; t < safeDuration; t += majorStep) {
      values.push(t);
    }
    return values;
  }, [majorStep, safeDuration]);
  const minorStep = useMemo(() => {
    if (safeDuration <= 0) return 1;
    // ~10 subdivisions per major interval (was /5 → e.g. only 4 ticks between 0–10s).
    const base = Math.max(1, Math.round(majorStep / 10));
    const maxTicks = 1200;
    const expectedTicks = Math.ceil(safeDuration / base);
    if (expectedTicks <= maxTicks) return base;
    const multiplier = Math.ceil(expectedTicks / maxTicks);
    return base * multiplier;
  }, [majorStep, safeDuration]);
  const minorTicks = useMemo(() => {
    if (safeDuration <= 0) return [0];
    const values: number[] = [];
    for (let t = 0; t < safeDuration; t += minorStep) {
      values.push(t);
    }
    return values;
  }, [minorStep, safeDuration]);

  const { wavesurfer } = useWavesurfer({
    container: waveformRef,
    url: waveUrl,
    waveColor: '#FFFFFF',
    progressColor: 'rgba(255, 255, 255, 0.35)',
    cursorColor: 'transparent',
    barWidth: 2,
    barRadius: 0,
    barGap: 2,
    height: 28,
    normalize: true,
    backend: 'WebAudio',
    mediaControls: false,
    interact: true,
  });

  useEffect(() => {
    if (!wavesurfer) return;
    const unsub = wavesurfer.on('interaction', () => {
      const duration = wavesurfer.getDuration();
      if (!duration || duration <= 0) return;
      const current = wavesurfer.getCurrentTime();
      onProgressChange((current / duration) * 100);
    });
    return () => {
      unsub?.();
    };
  }, [wavesurfer, onProgressChange]);

  useEffect(() => {
    if (!wavesurfer) return;
    if (!Number.isFinite(progressPct)) return;
    const clamped = Math.min(100, Math.max(0, progressPct));
    wavesurfer.seekTo(clamped / 100);
  }, [progressPct, wavesurfer]);

  useEffect(() => {
    let cancelled = false;
    const src = mediaSrc?.trim();
    if (!src) {
      setFirstFrameUrl('');
      return;
    }

    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.crossOrigin = 'anonymous';
    video.src = src;
    video.playsInline = true;

    const handleLoadedData = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, video.videoWidth || 1);
        canvas.height = Math.max(1, video.videoHeight || 1);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          setFirstFrameUrl('');
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        if (!cancelled) setFirstFrameUrl(dataUrl);
      } catch {
        // Cross-origin videos may block canvas extraction; degrade gracefully.
        setFirstFrameUrl('');
      }
    };

    video.addEventListener('loadeddata', handleLoadedData, { once: true });
    video.load();

    return () => {
      cancelled = true;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [mediaSrc]);

  const getProgressPctFromClientX = useCallback((clientX: number) => {
    const scroller = scrollRef.current;
    const outer = timelineOuterRef.current;
    if (!scroller || !outer) return 0;
    const x = clientX - scroller.getBoundingClientRect().left + scroller.scrollLeft;
    const inset = PLAYHEAD_EDGE_INSET_PX;
    const innerW = outer.clientWidth - inset * 2;
    if (innerW <= 0) return 0;
    return Math.min(100, Math.max(0, ((x - inset) / innerW) * 100));
  }, []);

  const onPlayheadPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      playheadDraggingRef.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      onProgressChange(getProgressPctFromClientX(e.clientX));
    },
    [getProgressPctFromClientX, onProgressChange],
  );

  const onPlayheadPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!playheadDraggingRef.current) return;
      e.preventDefault();
      onProgressChange(getProgressPctFromClientX(e.clientX));
    },
    [getProgressPctFromClientX, onProgressChange],
  );

  const onPlayheadPointerUp = useCallback((e: React.PointerEvent) => {
    if (!playheadDraggingRef.current) return;
    playheadDraggingRef.current = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* capture already released */
    }
  }, []);

  const onPlayheadLostPointerCapture = useCallback(() => {
    playheadDraggingRef.current = false;
  }, []);

  const onRulerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (safeDuration <= 0) return;
      e.stopPropagation();
      const rawPct = getProgressPctFromClientX(e.clientX);
      const t = (rawPct / 100) * safeDuration;
      const snapped = Math.min(safeDuration, Math.max(0, Math.round(t / minorStep) * minorStep));
      onProgressChange((snapped / safeDuration) * 100);
    },
    [getProgressPctFromClientX, minorStep, onProgressChange, safeDuration],
  );

  const showPlayhead = safeDuration > 0 && Number.isFinite(progressPct);
  const clampedProgressPct = Math.min(100, Math.max(0, progressPct));

  return (
    <div
      ref={scrollRef}
      className='mt-1 overflow-x-scroll pb-1 pt-1 [scrollbar-width:auto] [-ms-overflow-style:auto] [&::-webkit-scrollbar]:h-[8px] [&::-webkit-scrollbar-thumb]:rounded-[8px] [&::-webkit-scrollbar-thumb]:bg-[#BFBFBF] [&::-webkit-scrollbar-track]:rounded-[8px] [&::-webkit-scrollbar-track]:bg-[#E6E6E6]'
    >
      <div ref={timelineOuterRef} className='relative min-w-full' style={{ width: `max(100%, ${timelineOuterMinWidthPx}px)` }}>
        <div
          className='relative'
          style={{
            marginLeft: PLAYHEAD_EDGE_INSET_PX,
            marginRight: PLAYHEAD_EDGE_INSET_PX,
            width: `calc(100% - ${PLAYHEAD_EDGE_INSET_PX * 2}px)`,
          }}
        >
          <div
            className='relative h-7 cursor-pointer select-none rounded-sm bg-transparent'
            onPointerDown={onRulerPointerDown}
          >
            {minorTicks.map((v) => {
              const left = safeDuration > 0 ? (v / safeDuration) * 100 : 0;
              const isMajor = Math.abs(v / majorStep - Math.round(v / majorStep)) < 1e-6;
              if (isMajor) return null;
              return (
                <span
                  key={`minor-${v}`}
                  className='absolute top-0 h-2 w-px bg-[#8E8E8E]'
                  style={{ left: `${left}%`, transform: 'translateX(-0.5px)' }}
                />
              );
            })}
            {majorTicks.map((v) => {
              const left = safeDuration > 0 ? (v / safeDuration) * 100 : 0;
              return (
                <span key={`major-${v}`} className='absolute inset-y-0' style={{ left: `${left}%` }}>
                  <span className='block h-full w-px bg-[#8E8E8E]' />
                  <span className='absolute bottom-0 left-1.5 whitespace-nowrap bg-transparent px-0 text-[10px] leading-[10px] tabular-nums text-text-default-secondary'>
                    {formatTickTime(v)}
                  </span>
                </span>
              );
            })}
          </div>
          <div
            className='mt-1 h-8 w-full rounded-sm bg-[#B0B0B0]'
            style={
              firstFrameUrl
                ? {
                  backgroundImage: `url(${firstFrameUrl})`,
                  backgroundRepeat: 'repeat-x',
                  backgroundSize: 'auto 100%',
                  backgroundPosition: 'left center',
                }
                : undefined
            }
          />
          <div
            ref={waveformRef}
            className='mt-1.5 h-[30px] w-full overflow-hidden rounded-sm bg-background-neutral-secondary-hover px-1'
            onMouseDown={(e) => e.stopPropagation()}
          />
        </div>

        {showPlayhead ? (
          <div className='pointer-events-none absolute inset-0 z-30'>
            <div
              className='pointer-events-auto absolute bottom-0 top-0 flex w-3 cursor-e-resize touch-none justify-center active:cursor-e-resize'
              style={{
                left: `calc(${PLAYHEAD_EDGE_INSET_PX}px + (100% - ${PLAYHEAD_EDGE_INSET_PX * 2}px) * ${clampedProgressPct / 100})`,
                transform: 'translateX(-50%)',
              }}
              onPointerDown={onPlayheadPointerDown}
              onPointerMove={onPlayheadPointerMove}
              onPointerUp={onPlayheadPointerUp}
              onPointerCancel={onPlayheadPointerUp}
              onLostPointerCapture={onPlayheadLostPointerCapture}
              role='slider'
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(clampedProgressPct)}
            >
              <div className='pointer-events-none relative flex h-full w-px flex-col items-center'>
                <div className='h-5 w-2.5 shrink-0 rounded-full bg-[#3A3A3A] shadow-[0_1px_2px_rgba(0,0,0,0.12)]' />
                <div className='mt-0 min-h-0 w-px flex-1 bg-[#3A3A3A]' />
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default memo(PlaybackTimelineSection);
