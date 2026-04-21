import React, { memo, useCallback, useMemo, useState } from 'react';
import type { VideoRef } from '@/apps/project/components/canvas/common/Video';
import { Button } from '@/components/base/button';
import { Icon } from '@/components/base/icon';
import Divider from '@/components/base/divider';
import { message } from '@/components/base/message';
import PlaybackPanel, { type TimelineCutMarker } from '../playback/PlaybackPanel';

export type CutBottomToolbarProps = {
  active: boolean;
  videoRef: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSave?: (payload: { cutMarkers: TimelineCutMarker[]; segments: Array<{ start: number; end: number }> }) => void;
};

const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';
const cutLabelClass = 'nodrag nopan inline-flex h-8 items-center gap-1';

const CutBottomToolbar: React.FC<CutBottomToolbarProps> = ({
  active,
  videoRef,
  mediaSrc,
  currentTime,
  duration,
  isPlaying,
  volume,
  fullscreenTargetRef,
  onClose,
  onSave,
}) => {
  const [cutMarkers, setCutMarkers] = useState<TimelineCutMarker[]>([]);
  const [activeCutMarkerId, setActiveCutMarkerId] = useState<string | null>(null);

  const sortedCutMarkers = useMemo(
    () => [...cutMarkers].sort((a, b) => a.progressPct - b.progressPct),
    [cutMarkers],
  );

  const segments = useMemo(() => {
    if (duration <= 0) return [];
    const markerTimes = sortedCutMarkers.map((m) => (m.progressPct / 100) * duration);
    const points = [0, ...markerTimes, duration];
    const result: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const start = points[i];
      const end = points[i + 1];
      if (end - start <= 0) continue;
      result.push({ start, end });
    }
    return result;
  }, [duration, sortedCutMarkers]);
  const canSave = sortedCutMarkers.length > 0 && segments.length > 1;

  const handleAddCutMarker = useCallback((progressPct: number) => {
    const id = `cut-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const nextMarker: TimelineCutMarker = {
      id,
      progressPct: Math.min(100, Math.max(0, progressPct)),
    };
    setCutMarkers((prev) => [...prev, nextMarker]);
    setActiveCutMarkerId(id);
  }, []);

  const handleRemoveCutMarker = useCallback((id: string) => {
    setCutMarkers((prev) => {
      const next = prev.filter((m) => m.id !== id);
      setActiveCutMarkerId((prevActive) => {
        if (prevActive !== id) return prevActive;
        if (next.length === 0) return null;
        return next[next.length - 1]?.id ?? null;
      });
      return next;
    });
  }, []);

  const handleSave = useCallback(() => {
    onSave?.({ cutMarkers: sortedCutMarkers, segments });
  }, [onSave, segments, sortedCutMarkers]);

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
          cutModeEnabled
          cutMarkers={cutMarkers}
          activeCutMarkerId={activeCutMarkerId}
          onAddCutMarker={handleAddCutMarker}
          onActivateCutMarker={setActiveCutMarkerId}
          onRemoveCutMarker={handleRemoveCutMarker}
        />
        <div
          className='nodrag nopan pointer-events-auto flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className={cutLabelClass}>
            <Icon name='videoNode-cut' width={20} height={20} color='var(--color-icon-base)' />
            <span className='whitespace-nowrap text-[14px] font-medium leading-none text-text-default-base'>Cut</span>
          </div>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <button
            type='button'
            className='nodrag nopan inline-flex h-7 items-center justify-center gap-1 rounded-[4px] border border-[#DBDBDB] px-1.5 text-icon-base transition-colors hover:bg-background-default-base-hover'
            aria-label='Auto split'
            onClick={() => message.warning('Auto Split coming soon')}
          >
            <Icon name='videoNode-auto-split' width={17} height={17} color='var(--color-icon-base)' />
            <span className='inline-flex items-center whitespace-nowrap text-[13px] font-medium leading-none text-text-default-base'>Auto Split</span>
          </button>
          <Button
            type='primary'
            shape='round'
            className='nodrag nopan !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D] disabled:!cursor-not-allowed disabled:!border-[#D9D9D9] disabled:!bg-[#F0F0F0] disabled:!text-[#B5B5B5]'
            onClick={handleSave}
            disabled={!canSave}
          >
            <Icon
              name='imageEditor-mark-save-icon'
              width={18}
              height={18}
              color={canSave ? '#FFFFFF' : '#B5B5B5'}
            />
            <span className='pl-2'>Save</span>
          </Button>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <button
            type='button'
            className={iconBtnClass}
            aria-label='Close cut mode'
            onClick={onClose}
          >
            <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='var(--color-icon-base)' />
          </button>
        </div>
      </div>
    </div>
  );
};

export default memo(CutBottomToolbar);
