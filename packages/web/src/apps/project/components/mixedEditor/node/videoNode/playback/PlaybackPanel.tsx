import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VideoRef } from '@/apps/project/components/canvas/common/Video';
import PlaybackTimelineSection from './PlaybackTimelineSection';
import PlaybackToolbar from './PlaybackToolbar';
import {
  PLAYBACK_SPEED_DEFAULT,
} from './playbackSpeed';

export type TimelineCutMarker = {
  id: string;
  progressPct: number;
};

export type PlaybackPanelProps = {
  videoRef: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  /** Node body element for fullscreen (toolbar is portaled outside the node DOM) */
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
  cutModeEnabled?: boolean;
  cutMarkers?: TimelineCutMarker[];
  activeCutMarkerId?: string | null;
  onAddCutMarker?: (progressPct: number) => void;
  onActivateCutMarker?: (id: string) => void;
  onRemoveCutMarker?: (id: string) => void;
  playbackRate?: number;
  onPlaybackRateChange?: (value: number) => void;
  /**
   * When both are set, timeline zoom is controlled by the parent (e.g. to keep erase tracking strip width in sync).
   * Otherwise zoom is managed inside this panel.
   */
  timelineZoom?: number;
  onTimelineZoomChange?: (value: number) => void;
};

const PlaybackPanel: React.FC<PlaybackPanelProps> = ({
  videoRef,
  mediaSrc,
  currentTime,
  duration,
  isPlaying,
  volume,
  fullscreenTargetRef,
  cutModeEnabled = false,
  cutMarkers = [],
  activeCutMarkerId = null,
  onAddCutMarker,
  onActivateCutMarker,
  onRemoveCutMarker,
  playbackRate: playbackRateProp,
  onPlaybackRateChange,
  timelineZoom: timelineZoomProp,
  onTimelineZoomChange,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [internalTimelineZoom, setInternalTimelineZoom] = useState(50);
  const zoomControlled = timelineZoomProp !== undefined && onTimelineZoomChange !== undefined;
  const timelineZoom = zoomControlled ? timelineZoomProp : internalTimelineZoom;
  const setTimelineZoom = useCallback(
    (value: number) => {
      if (zoomControlled) onTimelineZoomChange(value);
      else setInternalTimelineZoom(value);
    },
    [zoomControlled, onTimelineZoomChange],
  );
  const playbackRate = playbackRateProp ?? PLAYBACK_SPEED_DEFAULT;

  const timelineDisplayDuration = useMemo(() => {
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    return duration / playbackRate;
  }, [duration, playbackRate]);

  const timelineDisplayCurrentTime = useMemo(() => {
    if (!Number.isFinite(currentTime) || currentTime <= 0) return 0;
    return currentTime / playbackRate;
  }, [currentTime, playbackRate]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video?.setPlaybackRate) return;
    video.setPlaybackRate(playbackRate);
  }, [playbackRate, videoRef]);

  useEffect(() => {
    if (!mediaSrc) return;
    onPlaybackRateChange?.(PLAYBACK_SPEED_DEFAULT);
  }, [mediaSrc, onPlaybackRateChange]);

  const progressPct = useMemo(() => {
    if (!duration || duration <= 0) return 0;
    return Math.min(100, Math.max(0, (currentTime / duration) * 100));
  }, [currentTime, duration]);

  const handleProgressChange = (value: number) => {
    const v = videoRef.current;
    if (!v) return;
    const dur = v.getDuration?.() ?? duration;
    if (dur <= 0) return;
    v.setCurrentTime?.((value / 100) * dur);
  };

  const handleFullscreen = useCallback(() => {
    const el = fullscreenTargetRef?.current ?? rootRef.current?.closest('.react-flow__node') ?? rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen?.();
    }
  }, [fullscreenTargetRef]);

  return (
    <div
      ref={rootRef}
      className='breatic-video-playback-panel nodrag pointer-events-auto box-border flex w-[680px] shrink-0 flex-col rounded-[8px] border border-border-default-base bg-[#E8E8E8] p-[6px] shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)] [&_a]:cursor-default [&_a]:!text-text-default-secondary [&_a]:no-underline'
      onMouseDown={(e) => e.stopPropagation()}
    >
      <PlaybackToolbar
        videoRef={videoRef}
        currentTime={currentTime}
        duration={duration}
        displayCurrentTime={timelineDisplayCurrentTime}
        displayDuration={timelineDisplayDuration}
        isPlaying={isPlaying}
        volume={volume}
        timelineZoom={timelineZoom}
        onTimelineZoomChange={setTimelineZoom}
        onFullscreen={handleFullscreen}
      />
      <PlaybackTimelineSection
        progressPct={progressPct}
        duration={timelineDisplayDuration}
        mediaSrc={mediaSrc}
        onProgressChange={handleProgressChange}
        timelineZoom={timelineZoom}
        cutModeEnabled={cutModeEnabled}
        cutMarkers={cutMarkers}
        activeCutMarkerId={activeCutMarkerId}
        onAddCutMarker={onAddCutMarker}
        onActivateCutMarker={onActivateCutMarker}
        onRemoveCutMarker={onRemoveCutMarker}
      />
    </div>
  );
};

export default memo(PlaybackPanel);
