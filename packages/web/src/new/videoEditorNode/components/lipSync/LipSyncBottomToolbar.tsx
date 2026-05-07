import React, { memo, useState } from 'react';
import type { VideoRef } from '@/spaces/canvas/common/Video';
import { Button } from '@/ui/button';
import { Icon } from '@/ui/icon';
import PlaybackPanel from '../playback/PlaybackPanel';

type LipSyncBottomToolbarProps = {
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

const LipSyncBottomToolbar: React.FC<LipSyncBottomToolbarProps> = ({
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
  const [audioName, setAudioName] = useState('');
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
      <div className='w-[460px] rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-3 py-2 shadow-[0_1px_3px_rgba(0,0,0,0.08)]'>
        <div className='mb-2 inline-flex items-center gap-1 text-[14px] font-semibold'>
          <Icon name='videoNode-lip-sync' width={18} height={18} />
          <span>Lip Sync</span>
        </div>
        <input
          type='text'
          value={audioName}
          onChange={(e) => setAudioName(e.target.value)}
          placeholder='Audio file or voice id'
          className='h-9 w-full rounded-[8px] border border-[#DBDBDB] px-2 text-[13px] outline-none'
        />
        <div className='mt-2 flex items-center justify-end gap-2'>
          <button type='button' onClick={onClose} className='h-8 rounded-md border border-[#DBDBDB] px-3 text-[12px]'>
            Close
          </button>
          <Button
            type='primary'
            shape='round'
            className='!h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
            icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
            onClick={onSend}
            disabled={!audioName.trim()}
          />
        </div>
      </div>
    </div>
  );
};

export default memo(LipSyncBottomToolbar);
