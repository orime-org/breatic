import React, { memo, useCallback, useState } from 'react';
import type { VideoRef } from '@/apps/project/components/canvas/common/Video';
import { Button } from '@/components/base/button';
import { Icon } from '@/components/base/icon';
import Divider from '@/components/base/divider';
import Tooltip from '@/components/base/tooltip';
import PlaybackPanel from '../playback/PlaybackPanel';
import EraseTrackingPanel, { type EraseTrackingPhase, type EraseTrackingSegment } from './EraseTrackingPanel';

export type VideoEraseMaskTool = 'selection' | 'rectangle' | 'circle';

type EraseBottomToolbarProps = {
  active: boolean;
  videoRef: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
  trackingPhase?: EraseTrackingPhase;
  trackingSegments?: EraseTrackingSegment[];
  maskTool?: VideoEraseMaskTool;
  onMaskToolChange?: (tool: VideoEraseMaskTool) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onClose: () => void;
  onSend?: () => void;
};

const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';
const eraseLabelClass = 'nodrag nopan inline-flex h-8 items-center gap-1';
const iconBtnDisabledClass = 'cursor-not-allowed text-icon-disabled hover:bg-transparent opacity-50';
const getHistoryBtnClass = (enabled: boolean) => `${iconBtnClass} ${enabled ? '' : iconBtnDisabledClass}`;
const ERASE_CREDIT = 120;

const EraseBottomToolbar: React.FC<EraseBottomToolbarProps> = ({
  active,
  videoRef,
  mediaSrc,
  currentTime,
  duration,
  isPlaying,
  volume,
  fullscreenTargetRef,
  trackingPhase = 'idle',
  trackingSegments = [],
  maskTool = 'selection',
  onMaskToolChange,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onClose,
  onSend,
}) => {
  const [timelineZoom, setTimelineZoom] = useState(50);
  const handleMaskToolSelect = useCallback(
    (tool: VideoEraseMaskTool) => {
      videoRef.current?.pause();
      onMaskToolChange?.(tool);
    },
    [onMaskToolChange, videoRef],
  );

  if (!active) return null;
  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
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
      <EraseTrackingPanel
        phase={trackingPhase}
        mediaSrc={mediaSrc}
        currentTimeSec={currentTime}
        durationSec={duration}
        segments={trackingSegments}
        timelineZoom={timelineZoom}
      />
      <div className='flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'>
        <div className={eraseLabelClass}>
          <Icon name='videoNode-erase' width={20} height={20} color='var(--color-icon-base)' />
          <span className='whitespace-nowrap text-[14px] font-medium leading-none text-text-default-base'>Erase</span>
        </div>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <Tooltip title='Selection' placement='top' offset={4}>
          <button type='button' className={iconBtnClass} onClick={() => handleMaskToolSelect('selection')}>
            <Icon name='videoNode-erase-selection' width={20} height={20} color='var(--color-icon-base)' />
          </button>
        </Tooltip>
        <Tooltip title='Circle' placement='top' offset={4}>
          <button type='button' className={iconBtnClass} onClick={() => handleMaskToolSelect('circle')}>
            <Icon name='imageEditor-flow-inpaint-circle-icon' width={20} height={20} />
          </button>
        </Tooltip>
        <Tooltip title='Rectangle' placement='top' offset={4}>
          <button type='button' className={iconBtnClass} onClick={() => handleMaskToolSelect('rectangle')}>
            <Icon name='imageEditor-flow-inpaint-rectangle-icon' width={20} height={20} />
          </button>
        </Tooltip>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <Tooltip title='Undo' placement='top' offset={4}>
          <button type='button' className={getHistoryBtnClass(canUndo)} disabled={!canUndo} onClick={onUndo}>
            <Icon name='imageEditor-flow-inpaint-undo-icon' width={20} height={20} />
          </button>
        </Tooltip>
        <Tooltip title='Redo' placement='top' offset={4}>
          <button type='button' className={getHistoryBtnClass(canRedo)} disabled={!canRedo} onClick={onRedo}>
            <Icon name='imageEditor-flow-inpaint-redo-icon' width={20} height={20} />
          </button>
        </Tooltip>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <div className='nodrag nopan flex shrink-0 items-center gap-0.5 px-0.5 text-[13px] font-medium tabular-nums text-text-default-secondary'>
          <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
          <span>{ERASE_CREDIT}</span>
        </div>
        <Button
          type='primary'
          shape='round'
          className='nodrag nopan !ml-1 !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
          icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
          onClick={onSend}
        />
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <Tooltip title={maskTool} placement='top' offset={4}>
          <Button
            type='text'
            className='nodrag nopan !h-8 !min-w-0 !px-2 !text-[12px] !text-text-default-secondary hover:!bg-background-default-base-hover'
          >
            {maskTool}
          </Button>
        </Tooltip>
        <button type='button' className={iconBtnClass} aria-label='Close erase mode' onClick={onClose}>
          <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} color='var(--color-icon-base)' />
        </button>
      </div>
    </div>
  );
};

export default memo(EraseBottomToolbar);
export type { EraseTrackingPhase } from './EraseTrackingPanel';
