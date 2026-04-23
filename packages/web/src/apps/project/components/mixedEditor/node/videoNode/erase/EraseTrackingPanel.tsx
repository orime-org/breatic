import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/base/icon';
import { cn } from '@/utils/classnames';

export type EraseTrackingPhase = 'idle' | 'tracking';
export type EraseTrackingStatus = 'confirm' | 'unclear' | 'lost';
export type EraseTrackingBox = {
  cxPct: number;
  cyPct: number;
  wPct: number;
  hPct: number;
  maskShape?: 'rectangle' | 'circle';
  placeholderId?: string;
};
export type EraseTrackingSegment = {
  startSec: number;
  endSec: number;
  status: EraseTrackingStatus;
  boxes: EraseTrackingBox[];
};

/** Match `PlaybackTimelineSection` so erase confidence strip shares the same horizontal scale as the waveform. */
const TIMELINE_ZOOM_MIN_PX_PER_SEC = 4;
const TIMELINE_ZOOM_MAX_PX_PER_SEC = 32;
const LOST_PATTERN_ICON_SIZE_PX = 12;
const LOST_PATTERN_ICON_GAP_PX = 3;

const timelineScrollbarClass = 'overflow-x-auto overflow-y-visible pb-0.5 [scrollbar-width:auto] [-ms-overflow-style:auto] [&::-webkit-scrollbar]:h-[8px] [&::-webkit-scrollbar-thumb]:rounded-[8px] [&::-webkit-scrollbar-thumb]:bg-[#BFBFBF] [&::-webkit-scrollbar-track]:rounded-[8px] [&::-webkit-scrollbar-track]:bg-[#E6E6E6]';

export type EraseTrackingPanelProps = {
  /** `idle` — default hint; `tracking` — in-progress copy */
  phase?: EraseTrackingPhase;
  mediaSrc?: string;
  currentTimeSec?: number;
  durationSec?: number;
  segments?: EraseTrackingSegment[];
  /** Same 0–100 scale as playback toolbar zoom; widens the strip when increased. */
  timelineZoom?: number;
  className?: string;
};

const legendItems: Array<{ key: EraseTrackingStatus; dotClass: string; label: string; barClass: string }> = [
  { key: 'confirm', dotClass: 'bg-[#2FB344]', label: 'Confirm Tracking', barClass: 'bg-[#2FB344]' },
  { key: 'unclear', dotClass: 'bg-[#E8A317]', label: 'Unclear Tracking', barClass: 'bg-[#E8A317]' },
  { key: 'lost', dotClass: 'bg-[#E5484D]', label: 'Tracking Lost', barClass: 'bg-[#E5484D]' },
];
const statusColorMap: Record<EraseTrackingStatus, string> = {
  confirm: '#2FB344',
  unclear: '#E8A317',
  lost: '#E5484D',
};

const EraseTrackingPanel: React.FC<EraseTrackingPanelProps> = ({
  phase = 'idle',
  mediaSrc,
  currentTimeSec = 0,
  durationSec = 0,
  segments = [],
  timelineZoom = 50,
  className,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [firstFrameUrl, setFirstFrameUrl] = useState('');
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
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        if (!cancelled) setFirstFrameUrl(dataUrl);
      } catch {
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

  const safeDuration = useMemo(
    () => (Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0),
    [durationSec],
  );
  const zoomClamped = Math.min(100, Math.max(0, timelineZoom));
  const pixelsPerSecond = useMemo(
    () =>
      TIMELINE_ZOOM_MIN_PX_PER_SEC +
      (zoomClamped / 100) * (TIMELINE_ZOOM_MAX_PX_PER_SEC - TIMELINE_ZOOM_MIN_PX_PER_SEC),
    [zoomClamped],
  );

  const normalizedSegments = useMemo<EraseTrackingSegment[]>(() => {
    if (safeDuration <= 0) return [];
    return segments
      .map((item) => ({
        ...item,
        startSec: Math.min(safeDuration, Math.max(0, item.startSec)),
        endSec: Math.min(safeDuration, Math.max(0, item.endSec)),
      }))
      .filter((item) => item.endSec > item.startSec);
  }, [safeDuration, segments]);

  const currentStatus = (() => {
    if (phase !== 'tracking' || safeDuration <= 0 || normalizedSegments.length === 0) return null;
    const t = Math.min(safeDuration, Math.max(0, currentTimeSec));
    const seg = normalizedSegments.find((item) => t >= item.startSec && t <= item.endSec);
    return seg?.status ?? normalizedSegments[normalizedSegments.length - 1]?.status ?? null;
  })();
  const showTrackingBar = phase === 'tracking' && safeDuration > 0 && normalizedSegments.length > 0;

  const timelineWidthPx = useMemo(() => {
    if (!showTrackingBar) return 0;
    return Math.max(660, Math.ceil(safeDuration * pixelsPerSecond));
  }, [pixelsPerSecond, safeDuration, showTrackingBar]);
  const timelineOuterMinWidthPx = showTrackingBar ? timelineWidthPx : 0;

  let trackingStatusText = 'Select an element for tracking';
  if (phase === 'tracking' && !showTrackingBar) {
    trackingStatusText = 'Tracking...';
  } else if (showTrackingBar && currentStatus === 'lost') {
    trackingStatusText = 'Tracking Lost';
  } else if (showTrackingBar) {
    trackingStatusText = '';
  }
  const neutralStatusText = trackingStatusText === 'Select an element for tracking' || trackingStatusText === 'Tracking...';

  const trackingStrip = useMemo(() => {
    if (!showTrackingBar) return null;
    return normalizedSegments.map((segment, idx) => {
      const safeStart = Math.min(safeDuration, Math.max(0, segment.startSec));
      const safeEnd = Math.min(safeDuration, Math.max(0, segment.endSec));
      if (safeEnd <= safeStart) return null;
      const leftPct = (safeStart / safeDuration) * 100;
      const widthPct = ((safeEnd - safeStart) / safeDuration) * 100;
      return (
        <div
          key={`${segment.status}-${segment.startSec}-${segment.endSec}-${idx}`}
          className='absolute top-0 h-full'
          style={{
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            backgroundColor: statusColorMap[segment.status],
          }}
        />
      );
    });
  }, [normalizedSegments, safeDuration, showTrackingBar]);

  const trackingThumbStrip = useMemo(() => {
    if (!showTrackingBar) return null;
    return normalizedSegments.map((segment, idx) => {
      const safeStart = Math.min(safeDuration, Math.max(0, segment.startSec));
      const safeEnd = Math.min(safeDuration, Math.max(0, segment.endSec));
      if (safeEnd <= safeStart) return null;
      const leftPct = (safeStart / safeDuration) * 100;
      const widthPct = ((safeEnd - safeStart) / safeDuration) * 100;
      const segmentWidthPx = (timelineWidthPx * widthPct) / 100;
      const lostTileUnitPx = LOST_PATTERN_ICON_SIZE_PX + LOST_PATTERN_ICON_GAP_PX;
      const lostTileCount = Math.max(1, Math.ceil(segmentWidthPx / lostTileUnitPx));

      return (
        <div
          key={`thumb-${segment.status}-${segment.startSec}-${segment.endSec}-${idx}`}
          className='absolute inset-y-0 overflow-hidden rounded-[2px]'
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        >
          {segment.status === 'lost' ? (
            <div className='relative h-full w-full bg-[#EC221F]/50'>
              <div className='absolute inset-0 flex flex-nowrap items-center gap-[3px] overflow-hidden px-1 whitespace-nowrap'>
                {Array.from({ length: lostTileCount }).map((_, iconIdx) => (
                  <Icon
                    key={`lost-tile-${idx}-${iconIdx}`}
                    name='videoNode-tracking-lost'
                    width={LOST_PATTERN_ICON_SIZE_PX}
                    height={LOST_PATTERN_ICON_SIZE_PX}
                    color='#fff'
                    className='shrink-0'
                  />
                ))}
              </div>
            </div>
          ) : (
            <>
              <div
                className='h-full w-full bg-[#A5A5A5]'
                style={
                  firstFrameUrl
                    ? {
                      backgroundImage: `url("${firstFrameUrl}")`,
                      backgroundRepeat: 'repeat-x',
                      backgroundSize: 'auto 100%',
                    }
                    : undefined
                }
              />
              <div
                className='absolute inset-0 opacity-[0.24]'
                style={{ backgroundColor: statusColorMap[segment.status] }}
              />
            </>
          )}
        </div>
      );
    });
  }, [firstFrameUrl, normalizedSegments, safeDuration, showTrackingBar, timelineWidthPx]);

  return (
    <div
      className={cn(
        'nodrag nopan pointer-events-auto box-border flex w-[680px] shrink-0 flex-col overflow-hidden rounded-[8px] border border-[#DBDBDB] bg-white p-[4px] shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)]',
        className,
      )}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {showTrackingBar ? (
        <div ref={scrollRef} className={timelineScrollbarClass}>
          <div
            className='relative min-w-full overflow-visible'
            style={{ width: `max(100%, ${timelineOuterMinWidthPx}px)` }}
          >
            <div className='relative flex min-h-0 w-full flex-col gap-1'>
              <div className='relative h-[26px] overflow-hidden rounded-[2px] bg-[#E9E9E9]'>
                {trackingThumbStrip}
              </div>
              <div className='relative mb-1 h-[10px] overflow-hidden rounded-full bg-[#E9E9E9]'>
                {trackingStrip}
                {trackingStatusText ? (
                  <div className={cn(
                    'absolute inset-0 flex items-center justify-center px-2 text-center text-[10px] leading-none',
                    neutralStatusText ? 'text-text-default-tertiary' : 'text-white',
                  )}>
                    {trackingStatusText}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className='min-w-0'>
          <div className='relative h-[26px] overflow-hidden rounded-[2px] bg-[#E9E9E9]'>
            {trackingThumbStrip}
          </div>
          <div className='relative mt-1 h-[10px] overflow-hidden rounded-full bg-[#E9E9E9]'>
            {trackingStrip}
            {trackingStatusText ? (
              <div className={cn(
                'absolute inset-0 flex items-center justify-center px-2 text-center text-[10px] leading-none',
                neutralStatusText ? 'text-text-default-tertiary' : 'text-white',
              )}>
                {trackingStatusText}
              </div>
            ) : null}
          </div>
        </div>
      )}
      <div className='flex flex-wrap items-center gap-x-5 gap-y-2 bg-white p-2 text-[12px] leading-none'>
        <span className='font-semibold text-text-default-base'>Tracking Confidence:</span>
        {legendItems.map((item) => (
          <span key={item.key} className='inline-flex items-center gap-1.5 text-text-default-secondary'>
            <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', item.dotClass)} aria-hidden />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
};

export default memo(EraseTrackingPanel);
