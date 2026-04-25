import React, { useEffect, useRef, useCallback } from 'react';
import Slider from '@/components/base/slider';
import { Icon } from '@/components/base/icon';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
import PreviewCanvas from './PreviewCanvas';

interface FullscreenPreviewProps {
  visible: boolean;
  currentTime: number;
  isPlaying: boolean;
  canvasRatio: string;
  onClose: () => void;
  onPlayPause: () => void;
  onTimeChange: (time: number) => void;
  forceUpdateTextRef?: { current: (() => void) | null };
  nodeId?: string;
}

export const FullscreenPreview: React.FC<FullscreenPreviewProps> = ({
  visible,
  currentTime,
  isPlaying,
  canvasRatio,
  onClose,
  onPlayPause,
  onTimeChange,
  forceUpdateTextRef,
  nodeId,
}) => {
  const sliderClass = 'nodrag nopan !w-full';
  const containerRef = useRef<HTMLDivElement>(null);

  // store get clips calculate
  const { clips } = useVideoEditorStore();

  // calculate
  const duration = clips.length > 0 ? Math.max(...clips.map((c: { end: number }) => c.end)) : 0;

  // handleplayback/ ：ifplayback end， startplayback
  const handlePlayPause = () => {
    // ifplayback end（ time ）， startplayback
    if (currentTime >= duration - 0.1) {
      onTimeChange(0);
      onPlayPause();
    } else {
      onPlayPause();
    }
  };

  // handleclosefullscreen： fullscreen， closecomponent
  const handleClose = async () => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch (error) {
        console.error('退出全屏失败:', error);
      }
    }
    if (!document.fullscreenElement) {
      onClose();
    }
  };

  // fullscreen
  const requestFullscreen = useCallback(async (el: HTMLDivElement) => {
    try {
      // check supportfullscreen API
      if (el.requestFullscreen) {
        await el.requestFullscreen();
      } else if ('webkitRequestFullscreen' in el && typeof (el as HTMLElement & { webkitRequestFullscreen: () => Promise<void> }).webkitRequestFullscreen === 'function') {
        await (el as HTMLElement & { webkitRequestFullscreen: () => Promise<void> }).webkitRequestFullscreen();
      } else if ('mozRequestFullScreen' in el && typeof (el as HTMLElement & { mozRequestFullScreen: () => Promise<void> }).mozRequestFullScreen === 'function') {
        await (el as HTMLElement & { mozRequestFullScreen: () => Promise<void> }).mozRequestFullScreen();
      } else if ('msRequestFullscreen' in el && typeof (el as HTMLElement & { msRequestFullscreen: () => Promise<void> }).msRequestFullscreen === 'function') {
        await (el as HTMLElement & { msRequestFullscreen: () => Promise<void> }).msRequestFullscreen();
      } else {
        console.error('浏览器不支持全屏 API');
        onClose();
      }
    } catch (error: unknown) {
      console.error('进入全屏失败:', error);
      // if ， close ，
      if (error instanceof Error && error.name === 'NotAllowedError') {
        console.warn('全屏请求被拒绝，可能需要用户交互');
      } else {
        onClose();
      }
    }
  }, [onClose]);

  // handlefullscreen
  useEffect(() => {
    if (!visible || !containerRef.current || document.fullscreenElement) return;

    const el = containerRef.current;
    if (!el) return;

    // ensure DOM
    if (!el.isConnected) {
      return;
    }

    // fullscreen
    requestFullscreen(el);
  }, [visible, onClose, requestFullscreen]);

  // listenfullscreen
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && visible) {
        onClose();
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [visible, onClose]);

  // calculate time - supportframedisplay（ 30fps）
  const formatTime = (seconds: number) => {
    const totalFrames = Math.floor(seconds * 30);
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const frames = totalFrames % 30;

    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
  };

  // ， component
  if (!visible) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className='fullscreen-preview-container fixed inset-0 z-[2500] flex flex-col w-full h-full overflow-hidden bg-[#262626] group'
    >
      <div className='relative w-full h-full overflow-hidden'>
        {/* PreviewCanvas - ，fullscreen */}
        <div className='absolute inset-0 w-full h-full z-0'>
          <PreviewCanvas
            nodeId={nodeId}
            currentTime={currentTime}
            isPlaying={isPlaying}
            canvasRatio={canvasRatio}
            forceUpdateTextRef={forceUpdateTextRef}
            isFullscreen={true}
          />
        </div>

        {/* bottomplaybackcontrol - hover display */}
        <div className='fullscreen-controls-bar absolute bottom-0 left-0 right-0 z-[10000] flex justify-center px-8 pb-6 opacity-0 group-hover:opacity-100 transition-opacity duration-300'>
          <div className='flex items-center gap-4 px-6 rounded-lg bg-black/60 border border-gray-500 max-w-[960px] w-full h-[50px]'>
            {/* playback/ button */}
            <div
              className='flex items-center justify-center flex-shrink-0 cursor-pointer hover:scale-110'
              onClick={handlePlayPause}
            >
              {isPlaying ? (
                <Icon name='videoEditor-pause-icon' width={14} height={14} color='#ffffff' />
              ) : (
                <Icon name='videoEditor-play-icon' width={14} height={14} color='#ffffff' />
              )}
            </div>

            {/* timedisplay */}
            <div className='flex items-center flex-shrink-0 gap-2 font-mono text-white text-sm'>
              <span className='text-[#2073B1]'>
                {formatTime(currentTime)}
              </span>
              <span className='text-gray-400'>/</span>
              <span className='text-white'>{formatTime(duration)}</span>
            </div>

            {/* comment */}
            <div className='flex-1 pl-4'>
              <Slider
                min={0}
                max={duration}
                step={0.01}
                value={currentTime}
                onChange={onTimeChange}
                className={`${sliderClass} fullscreen-controls-slider`}
                activeColor='#5A5A5A'
                inactiveColor='#E3E3E3'
                trackHeight={6}
                thumbWidth={20}
                thumbHeight={16}
                thumbColor='#B3B3B3'
              />
            </div>
            <div className='w-px h-4 bg-white/40 shrink-0 self-center' aria-hidden />
            {/* fullscreenbutton */}
            <div
              className='flex items-center justify-center flex-shrink-0 cursor-pointer hover:scale-110'
              onClick={handleClose}
            >
              <Icon name='videoEditor-fullscreen-icon' width={14} height={14} color='#ffffff' />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

