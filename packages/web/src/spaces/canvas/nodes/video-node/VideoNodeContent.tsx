/**
 * Video node content area: Video (video + bottom playbar) + toolbar when selected (fullscreen, download, @, edit)
 */
import React, { memo, useRef, useState, useEffect } from 'react';
import { Icon } from '@/ui/icon';
import Video, { type VideoRef } from '../../common/Video';
import PreviewVideo from '../../common/PreviewVideo';

export interface VideoNodeContentProps {
  /** Video URL */
  src: string;
  /** Whether the node is selected; bottom playbar and toolbar are only shown when selected */
  selected?: boolean;
  /** Download click handler */
  onDownloadClick?: (e: React.MouseEvent) => void;
  /** @ mention click handler */
  onMentionClick?: (e: React.MouseEvent) => void;
  /** Edit/clip click handler (optional) */
  onEditClick?: (e: React.MouseEvent) => void;
}

const toolbarBarClass = 'flex items-center gap-[2px] rounded-[4px] bg-white/80 p-[4px] shadow-sm nodrag';
const toolbarBtnClass =
  'flex h-[22px] w-[22px] items-center justify-center rounded-[4px] text-[#757575] hover:bg-black/5';

const VideoNodeContent: React.FC<VideoNodeContentProps> = ({
  src,
  selected = false,
  onDownloadClick,
  onMentionClick,
  onEditClick,
}) => {
  const videoRef = useRef<VideoRef>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenInitialTime, setFullscreenInitialTime] = useState<number | undefined>(undefined);
  const [fullscreenAutoPlay, setFullscreenAutoPlay] = useState(false);

  const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();

  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  const handleFullscreen = () => {
    const ref = videoRef.current;
    let currentPlayTime: number | undefined;
    let shouldAutoPlay = false;
    if (ref) {
      currentPlayTime = ref.getCurrentTime();
      if (ref.isPlaying()) {
        ref.pause();
        shouldAutoPlay = true;
      }
    }
    setFullscreenInitialTime(currentPlayTime);
    setFullscreenAutoPlay(shouldAutoPlay);
    setIsFullscreen(true);
  };

  const handleDownload = async () => {
    if (!src) return;
    try {
      const res = await fetch(src, { mode: 'cors' });
      if (!res.ok) throw new Error(res.statusText);
      const blob = await res.blob();
      const urlPath = src.split('?')[0].split('#')[0];
      const fileName = urlPath.split('/').pop() || `video_${Date.now()}.mp4`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.error('Failed to download video:', e);
    }
  };

  return (
    <div className='w-full h-full min-h-0 flex items-center justify-center overflow-hidden rounded-[8px] relative group'>
      <Video ref={videoRef} src={src} showControlBar={selected} className='rounded-[8px]' />

      {/* When selected: toolbar overlaid above the playbar */}
      {selected && (
        <div
          className='absolute bottom-14 left-0 right-0 z-10 nodrag flex justify-center rounded-b-[8px]'
          onMouseDown={stopPropagation}
        >
          <div className={toolbarBarClass}>
            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation();
                handleFullscreen();
              }}
              className={toolbarBtnClass}
              aria-label='Fullscreen'
            >
              <Icon name='project-chat-fullscreen-icon' width={12} height={12} color='#757575' />
            </button>
            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation();
                handleDownload();
                onDownloadClick?.(e);
              }}
              className={toolbarBtnClass}
              aria-label='Download'
            >
              <Icon name='project-chat-download-icon' width={20} height={20} color='#757575' />
            </button>
            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation();
                onMentionClick?.(e);
              }}
              className={toolbarBtnClass}
              aria-label='Mention'
            >
              <Icon name='project-chat-mention-icon' width={15} height={15} color='#757575' />
            </button>
            {onEditClick && (
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation();
                  onEditClick(e);
                }}
                className={toolbarBtnClass}
                aria-label='Edit'
              >
                <Icon name='project-thunderbolt-icon' width={16} height={16} color='#757575' />
              </button>
            )}
          </div>
        </div>
      )}

      <PreviewVideo
        open={isFullscreen}
        src={src}
        onClose={() => {
          setIsFullscreen(false);
          setFullscreenInitialTime(undefined);
          setFullscreenAutoPlay(false);
        }}
        initialTime={fullscreenInitialTime}
        autoPlay={fullscreenAutoPlay}
      />
    </div>
  );
};

export default memo(VideoNodeContent);
