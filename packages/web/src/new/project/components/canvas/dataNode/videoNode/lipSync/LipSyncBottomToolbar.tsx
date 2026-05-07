import React, { memo, useEffect, useMemo, useState } from 'react';
import { useWavesurfer } from '@wavesurfer/react';
import type { VideoRef } from '@/new/project/components/canvas/common/CanvasVideo';
import { Button } from '@/components/base/button';
import { Icon } from '@/components/base/icon';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import Upload, { type UploadFile } from '@/components/base/upload';
import PlaybackPanel from '../playback/PlaybackPanel';
import type { EraseTrackingSegment, EraseTrackingStatus } from '../erase/EraseTrackingPanel';

export type LipSyncPhase = 'idle' | 'identifying' | 'ready';
export type LipSyncVoiceState = 'idle' | 'checking' | 'valid' | 'invalid';
export type LipSyncFaceItem = {
  id: string;
  label: string;
  confidence: number;
  thumbnailUrl?: string;
};
export type LipSyncAudioItem = {
  id: string;
  name: string;
};

export type LipSyncBottomToolbarProps = {
  active: boolean;
  videoRef: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
  phase: LipSyncPhase;
  faces: LipSyncFaceItem[];
  selectedFaceId: string | null;
  trackingSegments: EraseTrackingSegment[];
  audioTrackSrc?: string;
  selectedAudioName?: string;
  voiceState: LipSyncVoiceState;
  voiceMessage?: string;
  onFaceSelect: (faceId: string) => void;
  onRedetect: () => void;
  onUploadAudio: (file: File) => void;
  onClose: () => void;
  onSend?: () => void;
  canSend?: boolean;
};

const LIP_SYNC_CREDIT = 120;
const matchModeItems: Array<{ key: string; label: string }> = [
  { key: 'smart-speed-match', label: 'Smart speed match' },
  { key: 'freeze-last-frame', label: 'Freeze last frame' },
  { key: 'loop-video', label: 'Loop video' },
  { key: 'trim-to-video', label: 'Trim to video' },
];

const matchDropdownItems: MenuItemType[] = matchModeItems.map((item) => ({ key: item.key, label: item.label }));

const statusColorMap: Record<EraseTrackingStatus, string> = {
  confirm: '#2FB344',
  unclear: '#E8A317',
  lost: '#E5484D',
};
const LOST_PATTERN_ICON_SIZE_PX = 12;
const LOST_PATTERN_ICON_GAP_PX = 3;
const TIMELINE_ZOOM_MIN_PX_PER_SEC = 4;
const TIMELINE_ZOOM_MAX_PX_PER_SEC = 32;
const timelineScrollbarClass = 'overflow-x-auto overflow-y-visible pb-0.5 [scrollbar-width:auto] [-ms-overflow-style:auto] [&::-webkit-scrollbar]:h-[8px] [&::-webkit-scrollbar-thumb]:rounded-[8px] [&::-webkit-scrollbar-thumb]:bg-[#BFBFBF] [&::-webkit-scrollbar-track]:rounded-[8px] [&::-webkit-scrollbar-track]:bg-[#E6E6E6]';

const LipSyncBottomToolbar: React.FC<LipSyncBottomToolbarProps> = ({
  active,
  videoRef,
  mediaSrc,
  currentTime,
  duration,
  isPlaying,
  volume,
  fullscreenTargetRef,
  phase,
  faces,
  selectedFaceId,
  trackingSegments,
  audioTrackSrc,
  selectedAudioName: _selectedAudioName,
  voiceState,
  voiceMessage,
  onFaceSelect,
  onRedetect,
  onUploadAudio,
  onClose,
  onSend,
  canSend = false,
}) => {
  const [timelineZoom, setTimelineZoom] = useState(50);
  const [selectedMatchMode, setSelectedMatchMode] = useState<string>('smart-speed-match');
  const [isMatchModeOpen, setIsMatchModeOpen] = useState(false);
  const [firstFrameUrl, setFirstFrameUrl] = useState('');
  const isAudioChecking = voiceState === 'checking';
  const selectedMatchLabel = matchModeItems.find((item) => item.key === selectedMatchMode)?.label ?? 'Smart speed match';
  const safeDuration = useMemo(() => (Number.isFinite(duration) ? Math.max(0, duration) : 0), [duration]);
  const zoomClamped = Math.min(100, Math.max(0, timelineZoom));
  const pixelsPerSecond = useMemo(
    () =>
      TIMELINE_ZOOM_MIN_PX_PER_SEC +
      (zoomClamped / 100) * (TIMELINE_ZOOM_MAX_PX_PER_SEC - TIMELINE_ZOOM_MIN_PX_PER_SEC),
    [zoomClamped],
  );

  const normalizedSegments = useMemo<EraseTrackingSegment[]>(() => {
    if (safeDuration <= 0) return [];
    return trackingSegments
      .map((segment) => ({
        ...segment,
        startSec: Math.min(safeDuration, Math.max(0, segment.startSec)),
        endSec: Math.min(safeDuration, Math.max(0, segment.endSec)),
      }))
      .filter((segment) => segment.endSec > segment.startSec);
  }, [safeDuration, trackingSegments]);

  const showTrackingBar = safeDuration > 0 && normalizedSegments.length > 0;
  const timelineWidthPx = useMemo(() => {
    if (!showTrackingBar) return 0;
    return Math.max(660, Math.ceil(safeDuration * pixelsPerSecond));
  }, [pixelsPerSecond, safeDuration, showTrackingBar]);
  const timelineOuterMinWidthPx = showTrackingBar ? timelineWidthPx : 0;

  const currentStatus = useMemo(() => {
    if (!showTrackingBar) return null;
    const t = Math.min(safeDuration, Math.max(0, currentTime));
    const activeSegment = normalizedSegments.find((segment) => t >= segment.startSec && t <= segment.endSec);
    return activeSegment?.status ?? normalizedSegments[normalizedSegments.length - 1]?.status ?? null;
  }, [currentTime, normalizedSegments, safeDuration, showTrackingBar]);

  let trackingStatusText = 'Select an element for tracking';
  if (phase === 'identifying') {
    trackingStatusText = 'Tracking...';
  } else if (showTrackingBar && currentStatus === 'lost') {
    trackingStatusText = 'Tracking Lost';
  } else if (showTrackingBar) {
    trackingStatusText = '';
  }
  const isTrackingLoading = phase === 'identifying';
  const neutralStatusText = trackingStatusText === 'Select an element for tracking' || trackingStatusText === 'Tracking...';
  const shouldShowTrackingSection = !isTrackingLoading;

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
  const audioWaveformRef = React.useRef<HTMLDivElement | null>(null);
  const audioWaveUrl = audioTrackSrc?.trim() ? audioTrackSrc : undefined;
  const { wavesurfer: audioTrackWaveSurfer } = useWavesurfer({
    container: audioWaveformRef,
    url: audioWaveUrl,
    waveColor: '#FFFFFF',
    progressColor: 'rgba(255, 255, 255, 0.35)',
    cursorColor: 'transparent',
    barWidth: 2,
    barRadius: 0,
    barGap: 2,
    height: 22,
    normalize: true,
    backend: 'WebAudio',
    mediaControls: false,
    interact: false,
  });

  useEffect(() => {
    if (!audioTrackWaveSurfer) return;
    audioTrackWaveSurfer.seekTo(0);
  }, [audioTrackWaveSurfer, audioWaveUrl]);

  if (!active) return null;

  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <div className='flex flex-col items-center gap-1'>
        <PlaybackPanel
          videoRef={videoRef}
          mediaSrc={mediaSrc}
          currentTime={currentTime}
          duration={duration}
          isPlaying={isPlaying}
          volume={volume}
          fullscreenTargetRef={fullscreenTargetRef}
          timelineZoom={timelineZoom}
          onTimelineZoomChange={setTimelineZoom}
          hideFilmstripAndWaveform
        />
        <div
          className='nodrag nopan pointer-events-auto flex w-[680px] flex-col gap-2 rounded-[8px] bg-background-default-base p-2 shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className='flex items-center justify-between'>
            <div className='inline-flex items-center gap-1.5'>
              <Icon name='videoNode-lip-sync' width={18} height={16} color='var(--color-icon-base)' />
              <span className='text-[14px] font-semibold text-text-default-base'>Lip Sync</span>
            </div>
            <button
              type='button'
              className='inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-icon-base transition-colors hover:bg-background-default-base-hover'
              aria-label='Close lip sync mode'
              onClick={onClose}
            >
              <Icon name='imageEditor-multi-angle-close-icon' width={18} height={18} color='var(--color-icon-base)' />
            </button>
          </div>

          <div className='flex items-center justify-between gap-2'>
            <div className='flex flex-wrap items-center gap-1.5'>
              {faces.length > 0 ? (
                faces.map((face) => {
                  const activeFace = face.id === selectedFaceId;
                  const thumbSrc = (face.thumbnailUrl?.trim() || firstFrameUrl || '').trim();
                  return (
                    <button
                      key={face.id}
                      type='button'
                      className={`inline-flex h-[44px] items-center gap-2 rounded-[6px] border px-2 py-1 text-left ${
                        activeFace ? 'border-[#7F88FF] bg-[#EEF0FF] text-[#5760D4]' : 'border-[#D5D5D5] bg-[#F3F3F3] text-text-default-secondary hover:bg-[#ECECEC]'
                      }`}
                      onClick={() => onFaceSelect(face.id)}
                    >
                      <span className='relative inline-flex h-8 w-8 shrink-0 overflow-hidden rounded-[6px] bg-[#8C8C8C]'>
                        {thumbSrc ? (
                          <img
                            src={thumbSrc}
                            alt={face.label}
                            className='h-full w-full object-cover'
                            loading='lazy'
                          />
                        ) : null}
                      </span>
                      <span className='inline-flex flex-col leading-none'>
                        <span className={`text-[12px] font-semibold ${activeFace ? 'text-[#5760D4]' : 'text-[#8A8A8A]'}`}>{face.label}</span>
                        <span className={`mt-1 tabular-nums text-[12px] font-semibold ${activeFace ? 'text-[#5760D4]' : 'text-[#8A8A8A]'}`}>{Math.round(face.confidence * 100)}%</span>
                      </span>
                    </button>
                  );
                })
              ) : null}
            </div>
            <button
              type='button'
              className='inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-border-default-base px-2 text-[12px] text-text-default-secondary transition-colors hover:bg-background-default-base-hover'
              onClick={onRedetect}
            >
              <Icon name='project-re-detect-icon' width={12} height={14} color='var(--color-icon-base)' />
              Re-detect
            </button>
          </div>

          <div className={shouldShowTrackingSection ? undefined : 'hidden'}>
            {showTrackingBar ? (
              <div className={timelineScrollbarClass}>
                <div
                  className='relative min-w-full overflow-visible'
                  style={{ width: `max(100%, ${timelineOuterMinWidthPx}px)` }}
                >
                  <div
                    className='relative flex min-h-0 w-full flex-col gap-1'
                  >
                    <div className='relative h-[26px] overflow-hidden rounded-[2px] bg-[#E9E9E9]'>
                      {isTrackingLoading ? null : trackingThumbStrip}
                    </div>
                    <div className='relative h-[10px] overflow-hidden rounded-full bg-[#E9E9E9] mb-1'>
                      {isTrackingLoading ? null : trackingStrip}
                      {trackingStatusText ? (
                        <div className={`absolute inset-0 flex items-center justify-center px-2 text-center text-[10px] leading-none ${neutralStatusText ? 'text-text-default-tertiary' : 'text-white'}`}>
                          {trackingStatusText}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className='relative h-[26px] overflow-hidden rounded-[2px] bg-[#E9E9E9]'>
                  {isTrackingLoading ? null : trackingThumbStrip}
                </div>
                <div className='relative mt-1 h-[10px] overflow-hidden rounded-full bg-[#E9E9E9]'>
                  {isTrackingLoading ? null : trackingStrip}
                  {trackingStatusText ? (
                    <div className={`absolute inset-0 flex items-center justify-center px-2 text-center text-[10px] leading-none ${neutralStatusText ? 'text-text-default-tertiary' : 'text-white'}`}>
                      {trackingStatusText}
                    </div>
                  ) : null}
                </div>
              </>
            )}
            <div className='mt-1 flex items-center gap-5 text-[12px] leading-none'>
              <span className='font-semibold text-text-default-base'>Tracking Confidence:</span>
              <span className='inline-flex items-center gap-1 text-text-default-secondary'>
                <span className='h-2 w-2 rounded-full bg-[#2FB344]' />
                Confirm Tracking
              </span>
              <span className='inline-flex items-center gap-1 text-text-default-secondary'>
                <span className='h-2 w-2 rounded-full bg-[#E8A317]' />
                Unclear Tracking
              </span>
              <span className='inline-flex items-center gap-1 text-text-default-secondary'>
                <span className='h-2 w-2 rounded-full bg-[#E5484D]' />
                Tracking Lost
              </span>
            </div>
            {audioWaveUrl ? (
              <div className='mt-2'>
                <div className={timelineScrollbarClass}>
                  <div
                    className='relative min-w-full overflow-visible mb-1'
                    style={{ width: `max(100%, ${timelineOuterMinWidthPx || 660}px)` }}
                  >
                    <div className='relative h-[24px] w-full overflow-hidden rounded-[4px] bg-[#A5A6F6]'>
                      <div ref={audioWaveformRef} className='absolute inset-0 z-[1] h-full w-full px-1' />
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <Upload
            accept='audio/*'
            className='!block !w-full'
            disabled={isAudioChecking}
            showUploadList={false}
            fileList={[]}
            onChange={(info: { fileList: UploadFile[] }) => {
              const latest = info.fileList[info.fileList.length - 1];
              if (latest?.originFileObj) onUploadAudio(latest.originFileObj);
            }}
          >
            <button
              type='button'
              disabled={isAudioChecking}
              className={`relative flex h-[72px] w-full flex-col items-center justify-center rounded-[8px] border border-dashed border-border-default-base text-text-default-secondary transition-colors ${
                isAudioChecking
                  ? 'cursor-not-allowed bg-background-default-base'
                  : 'bg-background-default-secondary hover:bg-background-default-base-hover'
              }`}
              aria-label='Select voice audio'
            >
              {isAudioChecking ? (
                <>
                  <span className='relative inline-flex h-4 w-4 animate-spin rounded-full border border-[#9CA3AF] border-t-[#2FB344]' />
                  <span className='mt-1 text-[12px]'>Identifying...</span>
                </>
              ) : (
                <>
                  <span className='text-[34px] leading-none text-[#A3A3A3]'>+</span>
                  <span className='mt-1 text-[12px]'>Click to select a voice audio</span>
                </>
              )}
            </button>
          </Upload>

          <div className='flex items-center gap-2'>
            <Button
              className='!h-8 !rounded-full !border !border-border-default-base !bg-background-default-base !px-3 !text-[12px] !text-text-default-base hover:!bg-background-default-base-hover'
              icon={<Icon name='project-generate-tts-icon' width={16} height={16} color='var(--color-icon-base)' />}
            >
              Generate TTS
            </Button>
            <Dropdown
              trigger='click'
              placement='top-start'
              items={matchDropdownItems}
              open={isMatchModeOpen}
              onOpenChange={setIsMatchModeOpen}
              onClick={(key) => setSelectedMatchMode(key)}
              popupClassName='rounded-[8px] border border-border-default-base p-0'
              itemClassName='min-h-8 px-3 py-1 text-[13px]'
            >
              <button
                type='button'
                className='inline-flex h-8 items-center gap-1 rounded-[6px] bg-transparent px-2.5 text-[13px] text-text-default-base hover:bg-background-default-base-hover'
                aria-label='Lip sync mode'
              >
                <span>{selectedMatchLabel}</span>
                <Icon
                  name='base-chevron-down-icon'
                  width={10}
                  height={10}
                  color='var(--color-icon-base)'
                  className={`transition-transform duration-200 ${isMatchModeOpen ? 'rotate-180' : ''}`}
                />
              </button>
            </Dropdown>

            <div className='ml-auto flex items-center gap-2'>
              <div className='nodrag nopan flex shrink-0 items-center gap-0.5 px-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
                <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
                <span>{LIP_SYNC_CREDIT}</span>
              </div>
              <Button
                type='primary'
                shape='round'
                disabled={!canSend}
                className='nodrag nopan !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white disabled:!bg-[#9BDDA6] hover:!bg-[#28A13D]'
                icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
                aria-label='Send lip sync'
                onClick={onSend}
              />
            </div>
          </div>

          {voiceState === 'invalid' ? (
            <div className='rounded-[6px] border border-[#E5484D]/40 bg-[#FDECEC] px-3 py-2 text-center text-[13px] font-medium text-[#D92D20]'>
              {voiceMessage || 'No human voice detected'}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default memo(LipSyncBottomToolbar);
