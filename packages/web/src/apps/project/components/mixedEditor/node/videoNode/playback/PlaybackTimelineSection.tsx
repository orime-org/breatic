import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWavesurfer } from '@wavesurfer/react';
import { Icon } from '@/components/base/icon';
import { cn } from '@/utils/classnames';
import type { TimelineCutMarker } from './PlaybackPanel';

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
const CUT_MARKER_HIT_RADIUS_PX = 6;

const SCISSOR_CURSOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="21" height="22" viewBox="0 0 21 22" fill="none"><path d="M15.4277 21C14.1755 21 13.0794 20.5383 12.1943 19.6465C11.3098 18.755 10.8546 17.655 10.8545 16.4004C10.8545 16.0868 10.8821 15.7738 10.9365 15.4629C10.9543 15.3612 10.9784 15.261 11.0049 15.1621L10.0693 14.2197L9.88477 14.4043L4.90625 19.4219C4.69666 19.6331 4.45224 19.7993 4.17969 19.917C3.90329 20.0364 3.60827 20.0996 3.30273 20.0996C2.86213 20.0996 2.41923 19.9959 2.02832 19.7334C1.63752 19.4709 1.3735 19.0997 1.20605 18.6924C1.03822 18.284 0.966349 17.8352 1.05859 17.374C1.15081 16.9131 1.38955 16.5259 1.7002 16.2129L6.67969 11.1953L6.87402 11L1.67774 5.76465C1.36748 5.45201 1.12689 5.06407 1.03711 4.60058C0.947165 4.13607 1.02614 3.68605 1.20117 3.28027C1.375 2.87741 1.6438 2.51393 2.03418 2.25781C2.42431 2.00191 2.86443 1.90043 3.30274 1.90039C3.60827 1.90039 3.90329 1.96364 4.17969 2.08301C4.45224 2.20072 4.69667 2.36693 4.90625 2.57812L10.0693 7.78027L11.0049 6.83887C10.9783 6.7397 10.9544 6.63908 10.9365 6.53711C10.8821 6.22616 10.8545 5.91316 10.8545 5.59961C10.8546 4.34505 11.3098 3.24499 12.1943 2.35352C13.0794 1.46166 14.1755 1 15.4277 1C16.6799 1.00007 17.7752 1.46173 18.6602 2.35352C19.5448 3.24503 19.9999 4.34496 20 5.59961C20 6.85446 19.545 7.95506 18.6602 8.84668C17.7752 9.73847 16.6799 10.2001 15.4277 10.2002C15.1151 10.2002 14.8031 10.1723 14.4932 10.1172C14.3958 10.0999 14.2998 10.0781 14.2051 10.0527L13.2637 11L14.2051 11.9482C14.2999 11.9229 14.3957 11.9001 14.4932 11.8828C14.8031 11.8277 15.1151 11.7998 15.4277 11.7998C16.6799 11.7999 17.7752 12.2615 18.6602 13.1533C19.545 14.0449 20 15.1455 20 16.4004C19.9999 17.655 19.5448 18.755 18.6602 19.6465C17.7752 20.5383 16.6799 20.9999 15.4277 21ZM15.4277 6.40039C15.649 6.40033 15.8152 6.33256 15.9795 6.16699C16.144 6.00114 16.2139 5.82971 16.2139 5.59961C16.2138 5.36975 16.1439 5.19893 15.9795 5.0332C15.8152 4.86764 15.649 4.79987 15.4277 4.7998C15.2064 4.7998 15.0403 4.86765 14.876 5.0332C14.7115 5.19898 14.6417 5.36966 14.6416 5.59961C14.6416 5.82975 14.7114 6.00112 14.876 6.16699C15.0403 6.33247 15.2064 6.40039 15.4277 6.40039ZM9.62891 10.9375L10.1318 11.4443C10.2247 11.431 10.3079 11.3889 10.3809 11.3154L10.3857 11.3105C10.4562 11.2379 10.4968 11.1554 10.5098 11.0635L10.4463 11L10.5098 10.9375C10.4967 10.8433 10.4543 10.7585 10.3809 10.6846L10.3115 10.626C10.2565 10.5876 10.1964 10.566 10.1318 10.5566L10.0684 10.6201L10.0059 10.5566C9.94121 10.5659 9.8812 10.5876 9.82617 10.626L9.75586 10.6846C9.6825 10.7585 9.64201 10.8433 9.62891 10.9375ZM15.4277 17.2002C15.649 17.2001 15.8152 17.1324 15.9795 16.9668C16.1439 16.8011 16.2138 16.6303 16.2139 16.4004C16.2139 16.1703 16.144 15.9989 15.9795 15.833C15.8152 15.6674 15.649 15.5997 15.4277 15.5996C15.2064 15.5996 15.0403 15.6675 14.876 15.833C14.7114 15.9989 14.6416 16.1702 14.6416 16.4004C14.6417 16.6303 14.7115 16.801 14.876 16.9668C15.0403 17.1323 15.2064 17.2002 15.4277 17.2002Z" fill="white" stroke="#383838" stroke-width="2"/></svg>';

export type PlaybackTimelineSectionProps = {
  progressPct: number;
  duration: number;
  mediaSrc?: string;
  onProgressChange: (value: number) => void;
  /** 0 = most compressed, 100 = most stretched; scales ruler / waveform width. */
  timelineZoom: number;
  cutModeEnabled?: boolean;
  cutMarkers?: TimelineCutMarker[];
  activeCutMarkerId?: string | null;
  onAddCutMarker?: (progressPct: number) => void;
  onActivateCutMarker?: (id: string) => void;
  onRemoveCutMarker?: (id: string) => void;
  /**
   * When true, hides the filmstrip (thumbnail) row and the waveform row; keeps the time ruler,
   * tick labels, playhead, and ruler click-to-seek (e.g. video Adjust mode).
   */
  hideFilmstripAndWaveform?: boolean;
};

const PlaybackTimelineSection: React.FC<PlaybackTimelineSectionProps> = ({
  progressPct,
  duration,
  mediaSrc,
  onProgressChange,
  timelineZoom,
  cutModeEnabled = false,
  cutMarkers = [],
  activeCutMarkerId = null,
  onAddCutMarker,
  onActivateCutMarker,
  onRemoveCutMarker,
  hideFilmstripAndWaveform = false,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const timelineOuterRef = useRef<HTMLDivElement | null>(null);
  const waveformRef = useRef<HTMLDivElement | null>(null);
  const cutLayerRef = useRef<HTMLDivElement | null>(null);
  const playheadDraggingRef = useRef(false);
  const [hoverCutProgressPct, setHoverCutProgressPct] = useState<number | null>(null);
  const waveUrl =
    hideFilmstripAndWaveform ? undefined : mediaSrc?.trim() ? mediaSrc : undefined;
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
    if (hideFilmstripAndWaveform) {
      setFirstFrameUrl('');
      return;
    }
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
  }, [hideFilmstripAndWaveform, mediaSrc]);

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

  const snapProgressPct = useCallback(
    (rawPct: number) => {
      const clampedRaw = Math.min(100, Math.max(0, rawPct));
      if (safeDuration <= 0) return clampedRaw;
      const t = (clampedRaw / 100) * safeDuration;
      const snapped = Math.min(safeDuration, Math.max(0, Math.round(t / minorStep) * minorStep));
      return (snapped / safeDuration) * 100;
    },
    [minorStep, safeDuration],
  );

  const findClosestCutMarker = useCallback(
    (progressPct: number) => {
      const outer = timelineOuterRef.current;
      const innerW = (outer?.clientWidth ?? 0) - PLAYHEAD_EDGE_INSET_PX * 2;
      const thresholdPct = innerW > 0 ? (CUT_MARKER_HIT_RADIUS_PX / innerW) * 100 : 1;
      let closest: TimelineCutMarker | null = null;
      let minDiff = Infinity;
      for (const marker of cutMarkers) {
        const diff = Math.abs(marker.progressPct - progressPct);
        if (diff <= thresholdPct && diff < minDiff) {
          minDiff = diff;
          closest = marker;
        }
      }
      return closest;
    },
    [cutMarkers],
  );

  const placeCutMarkerByClientX = useCallback(
    (clientX: number) => {
      if (!cutModeEnabled || safeDuration <= 0) return;
      const snappedPct = snapProgressPct(getProgressPctFromClientX(clientX));
      const existing = findClosestCutMarker(snappedPct);
      if (existing) {
        onActivateCutMarker?.(existing.id);
        return;
      }
      onAddCutMarker?.(snappedPct);
    },
    [cutModeEnabled, findClosestCutMarker, getProgressPctFromClientX, onActivateCutMarker, onAddCutMarker, safeDuration, snapProgressPct],
  );

  const onCutLayerPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!cutModeEnabled || safeDuration <= 0) return;
      setHoverCutProgressPct(snapProgressPct(getProgressPctFromClientX(e.clientX)));
    },
    [cutModeEnabled, getProgressPctFromClientX, safeDuration, snapProgressPct],
  );

  const onCutLayerPointerLeave = useCallback(() => {
    setHoverCutProgressPct(null);
  }, []);

  const onCutLayerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!cutModeEnabled || safeDuration <= 0) return;
      e.preventDefault();
      e.stopPropagation();
      placeCutMarkerByClientX(e.clientX);
    },
    [cutModeEnabled, placeCutMarkerByClientX, safeDuration],
  );

  const showPlayhead = safeDuration > 0 && Number.isFinite(progressPct);
  const clampedProgressPct = Math.min(100, Math.max(0, progressPct));

  const scissorCursor = useMemo(() => {
    if (!cutModeEnabled) return undefined;
    return `url("data:image/svg+xml,${encodeURIComponent(SCISSOR_CURSOR_SVG)}") 10 10, crosshair`;
  }, [cutModeEnabled]);

  const hoverMarkerOverlapsExisting = useMemo(() => {
    if (hoverCutProgressPct == null) return false;
    return Boolean(findClosestCutMarker(hoverCutProgressPct));
  }, [findClosestCutMarker, hoverCutProgressPct]);

  const sortedCutMarkers = useMemo(
    () => [...cutMarkers].sort((a, b) => a.progressPct - b.progressPct),
    [cutMarkers],
  );

  const timelineSegments = useMemo(() => {
    const markerPoints = sortedCutMarkers
      .map((marker) => Math.min(100, Math.max(0, marker.progressPct)))
      .sort((a, b) => a - b);
    const points = [0, ...markerPoints, 100].filter((point, index, arr) => {
      if (index === 0) return true;
      return Math.abs(point - arr[index - 1]) > 1e-4;
    });
    return points
      .slice(0, -1)
      .map((startPct, index) => {
        const endPct = points[index + 1];
        return {
          key: `segment-${index}-${startPct.toFixed(4)}-${endPct.toFixed(4)}`,
          startPct,
          endPct,
          widthPct: Math.max(0, endPct - startPct),
        };
      })
      .filter((segment) => segment.widthPct > 0);
  }, [sortedCutMarkers]);

  return (
    <div
      ref={scrollRef}
      className={cn(
        'cursor-default overflow-x-scroll overflow-y-visible pb-1 [scrollbar-width:auto] [-ms-overflow-style:auto] [&::-webkit-scrollbar]:h-[8px] [&::-webkit-scrollbar]:cursor-default [&::-webkit-scrollbar-thumb]:cursor-default [&::-webkit-scrollbar-thumb]:rounded-[8px] [&::-webkit-scrollbar-thumb]:bg-[#BFBFBF] [&::-webkit-scrollbar-track]:rounded-[8px] [&::-webkit-scrollbar-track]:bg-[#E6E6E6]',
        hideFilmstripAndWaveform ? 'pt-2' : 'pt-4',
      )}
    >
      <div ref={timelineOuterRef} className='relative min-w-full overflow-visible' style={{ width: `max(100%, ${timelineOuterMinWidthPx}px)` }}>
        <div
          className='relative overflow-visible'
          style={{
            marginLeft: PLAYHEAD_EDGE_INSET_PX,
            marginRight: PLAYHEAD_EDGE_INSET_PX,
            width: `calc(100% - ${PLAYHEAD_EDGE_INSET_PX * 2}px)`,
          }}
        >
          <div className='relative h-7 cursor-pointer select-none rounded-sm bg-transparent mb-2' onPointerDown={onRulerPointerDown}>
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
          {hideFilmstripAndWaveform ? (
            <div ref={waveformRef} className='hidden h-0 w-0 overflow-hidden' aria-hidden />
          ) : (
            <>
              <div className='relative mt-1 h-8 w-full'>
                {timelineSegments.map((segment) => (
                  <div
                    key={`thumb-${segment.key}`}
                    className='absolute bottom-0 top-0 overflow-hidden rounded-[4px] bg-[#B0B0B0]'
                    style={{
                      left: `${segment.startPct}%`,
                      width: `${segment.widthPct}%`,
                      ...(firstFrameUrl
                        ? {
                          backgroundImage: `url(${firstFrameUrl})`,
                          backgroundRepeat: 'repeat-x',
                          backgroundSize: 'auto 100%',
                          backgroundPosition: 'left center',
                        }
                        : undefined),
                    }}
                  />
                ))}
                {sortedCutMarkers.map((marker) => (
                  <span
                    key={`thumb-cut-${marker.id}`}
                    className='pointer-events-none absolute bottom-0 top-0 z-[2] w-[2px] -translate-x-1/2 bg-[#E8E8E8]'
                    style={{ left: `${marker.progressPct}%` }}
                  />
                ))}
              </div>
              <div
                className='relative mt-1.5 h-[30px] w-full'
                onMouseDown={(e) => e.stopPropagation()}
              >
                {timelineSegments.map((segment) => (
                  <div
                    key={`wave-bg-${segment.key}`}
                    className='pointer-events-none absolute bottom-0 top-0 rounded-[4px] bg-background-neutral-secondary-hover'
                    style={{
                      left: `${segment.startPct}%`,
                      width: `${segment.widthPct}%`,
                    }}
                  />
                ))}
                <div ref={waveformRef} className='absolute inset-0 z-[1] h-full w-full px-1' />
                {sortedCutMarkers.map((marker) => (
                  <span
                    key={`wave-cut-${marker.id}`}
                    className='pointer-events-none absolute bottom-0 top-0 z-[2] w-[2px] -translate-x-1/2 bg-[#E8E8E8]'
                    style={{ left: `${marker.progressPct}%` }}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {cutModeEnabled ? (
          <div
            ref={cutLayerRef}
            className='pointer-events-none absolute inset-0 z-20 overflow-visible'
            style={{ cursor: scissorCursor }}
          >
            <div
              className='pointer-events-auto absolute inset-0'
              onPointerMove={onCutLayerPointerMove}
              onPointerLeave={onCutLayerPointerLeave}
              onPointerDown={onCutLayerPointerDown}
            />
            {sortedCutMarkers.map((marker) => {
              const isActive = marker.id === activeCutMarkerId;
              const markerLeft = `calc(${PLAYHEAD_EDGE_INSET_PX}px + (100% - ${PLAYHEAD_EDGE_INSET_PX * 2}px) * ${marker.progressPct / 100})`;
              return (
                <div
                  key={marker.id}
                  className='pointer-events-none absolute inset-0'
                >
                  <div
                    className='pointer-events-auto absolute top-0 z-[4] flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[#D8D8D8] bg-[#EDEDED] shadow-[0_1px_2px_rgba(0,0,0,0.08)] transition-colors hover:bg-[#E3E3E3]'
                    style={{ left: markerLeft }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onRemoveCutMarker?.(marker.id);
                    }}
                    role='button'
                    aria-label='Delete cut marker'
                  >
                    <Icon name='videoNode-cut-delete' width={12} height={12} className='block' />
                  </div>
                  <div
                    className='pointer-events-auto absolute bottom-0 top-0 w-[2px] -translate-x-1/2 cursor-pointer'
                    style={{
                      left: markerLeft,
                      backgroundColor: isActive ? '#5A63FF' : 'rgba(90, 99, 255, 0.65)',
                    }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onActivateCutMarker?.(marker.id);
                    }}
                    role='button'
                    aria-label='Activate cut marker'
                  />
                </div>
              );
            })}
            {hoverCutProgressPct != null && !hoverMarkerOverlapsExisting ? (
              <span
                className='absolute bottom-0 top-0 -translate-x-1/2 border-l-2 border-dashed border-[#5A63FF]'
                style={{
                  left: `calc(${PLAYHEAD_EDGE_INSET_PX}px + (100% - ${PLAYHEAD_EDGE_INSET_PX * 2}px) * ${hoverCutProgressPct / 100})`,
                }}
              />
            ) : null}
          </div>
        ) : null}

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
              <div className='pointer-events-none relative h-full w-px'>
                <div className='absolute top-0 left-1/2 h-5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#3A3A3A] shadow-[0_1px_2px_rgba(0,0,0,0.12)]' />
                <div className='absolute bottom-0 top-0 left-1/2 w-px -translate-x-1/2 bg-[#3A3A3A]' />
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default memo(PlaybackTimelineSection);
