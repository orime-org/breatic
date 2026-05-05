import React, { memo } from 'react';
import type { VideoRef } from '@/apps/project/components/canvas/common/Video';
import { Button } from '@/components/base/button';
import { Icon } from '@/components/base/icon';
import PlaybackPanel from '../playback/PlaybackPanel';

type CutoutBottomToolbarProps = {
  active: boolean;
  onClose: () => void;
  onSend?: () => void;
  videoRef?: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime?: number;
  duration?: number;
  isPlaying?: boolean;
  volume?: number;
};

const CutoutBottomToolbar: React.FC<CutoutBottomToolbarProps> = ({
  active,
  onClose,
  onSend,
  videoRef,
  mediaSrc,
  currentTime = 0,
  duration = 0,
  isPlaying = false,
  volume = 1,
}) => {
  if (!active) return null;
  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <PlaybackPanel
        videoRef={videoRef ?? { current: null }}
        mediaSrc={mediaSrc}
        currentTime={currentTime}
        duration={duration}
        isPlaying={isPlaying}
        volume={volume}
        hideFilmstripAndWaveform
      />
      <div className='flex h-[40px] items-center gap-2 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-3 py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'>
        <span className='text-[14px] font-medium'>Cutout</span>
        <Button
          type='primary'
          shape='round'
          className='!h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
          icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
          onClick={onSend}
        />
        <button type='button' onClick={onClose} className='h-8 rounded-md border border-[#DBDBDB] px-3 text-[12px]'>
          Close
        </button>
      </div>
    </div>
  );
};

export default memo(CutoutBottomToolbar);
