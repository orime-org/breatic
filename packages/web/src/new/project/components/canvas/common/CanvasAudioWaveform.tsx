/**
 * Waveform + playback controls for `new/project` canvas audio nodes.
 * Same UX as shared `AudioWaveformPlayer`.
 */
import React, { useRef, useState, useEffect } from 'react';
import { Icon } from '@/components/base/icon';
import Slider from '@/components/base/slider';
import { useWavesurfer } from '@wavesurfer/react';

const formatTime = (seconds: number) => {
  const s = Math.floor(seconds);
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export interface CanvasAudioWaveformProps {
  src: string;
  label?: string;
  active?: boolean;
  showControls?: boolean;
}

const CanvasAudioWaveform: React.FC<CanvasAudioWaveformProps> = ({
  src,
  label,
  active = false,
  showControls = true,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [progress, setProgress] = useState(0);
  const [volume, setVolume] = useState(1);
  const [previousVolume, setPreviousVolume] = useState(1);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const volumePopoverRef = useRef<HTMLDivElement | null>(null);

  const { wavesurfer } = useWavesurfer({
    container: containerRef,
    url: src,
    waveColor: '#B3B3B3',
    progressColor: '#262626',
    cursorColor: 'transparent',
    barWidth: 2,
    barRadius: 0,
    barGap: 2,
    height: 48,
    normalize: true,
    backend: 'WebAudio',
    mediaControls: false,
    interact: false,
  });

  useEffect(() => {
    if (!wavesurfer) return;

    const subscriptions = [
      wavesurfer.on('ready', () => {
        setDuration(wavesurfer.getDuration());
        setVolume(wavesurfer.getVolume());
      }),
      wavesurfer.on('play', () => {
        setIsPlaying(true);
      }),
      wavesurfer.on('pause', () => {
        setIsPlaying(false);
      }),
      wavesurfer.on('finish', () => {
        const dur = wavesurfer.getDuration();
        setIsPlaying(false);
        setCurrentTime(dur);
        setProgress(dur > 0 ? 100 : 0);
      }),
      wavesurfer.on('audioprocess', (time: number) => {
        const dur = wavesurfer.getDuration();
        setCurrentTime(time);
        setProgress(dur > 0 ? (time / dur) * 100 : 0);
      }),
    ];

    return () => {
      subscriptions.forEach((unsub) => unsub && unsub());
    };
  }, [wavesurfer]);

  useEffect(() => {
    if (!wavesurfer) return;
    if (active) {
      wavesurfer.play();
    } else {
      wavesurfer.pause();
    }
  }, [active, wavesurfer]);

  const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();

  const handlePlayPause = () => {
    if (!wavesurfer) return;
    wavesurfer.playPause();
  };

  const handleProgressChange = (value: number) => {
    if (!wavesurfer || !duration) return;
    const newTime = (value / 100) * duration;
    wavesurfer.seekTo(newTime / duration);
    setCurrentTime(newTime);
    setProgress(value);
  };

  const handleVolumeChange = (value: number) => {
    if (!wavesurfer) return;
    wavesurfer.setVolume(value);
    setVolume(value);
    if (value > 0) setPreviousVolume(value);
  };

  const handleMuteToggle = () => {
    if (!wavesurfer) return;
    if (volume === 0) {
      const restore = previousVolume > 0 ? previousVolume : 0.5;
      wavesurfer.setVolume(restore);
      setVolume(restore);
      setPreviousVolume(restore);
    } else {
      setPreviousVolume(volume);
      wavesurfer.setVolume(0);
      setVolume(0);
    }
  };

  const handleVolumeMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && volumePopoverRef.current && volumePopoverRef.current.contains(next)) {
      return;
    }
    setShowVolumeSlider(false);
  };

  return (
    <div className='flex flex-col rounded-lg'>
      {label && (
        <p className='mb-1 line-clamp-1 text-center text-[11px] font-medium text-[var(--color-text-default-secondary)]'>
          {label}
        </p>
      )}
      <div className='flex flex-1 flex-col items-center justify-center gap-2'>
        <div className='w-full h-[30px] rounded-lg overflow-hidden'>
          <div ref={containerRef} className='w-full h-full' />
        </div>
        {showControls && (
          <div className='nodrag flex w-full items-center gap-2'>
            <button
              type='button'
              onClick={handlePlayPause}
              className='flex-shrink-0 flex items-center justify-center w-8 h-8 text-[#383838] hover:opacity-80'
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <Icon name='project-pause-audio-icon' width={10} height={10} color='#383838' />
              ) : (
                <Icon name='project-play-audio-icon' width={10} height={12} color='#383838' />
              )}
            </button>
            <span className='flex-shrink-0 text-[12px] text-[#383838] font-normal tabular-nums'>
              {formatTime(currentTime)}
            </span>
            <div className='flex-1 min-w-0 flex items-center' onClick={stopPropagation}>
              <Slider
                min={0}
                max={100}
                step={0.1}
                value={progress}
                onChange={handleProgressChange}
                className='!m-0 w-full'
              />
            </div>
            <span className='flex-shrink-0 text-[12px] text-[#383838] font-normal tabular-nums'>
              {formatTime(duration)}
            </span>
            <div
              className='relative flex-shrink-0'
              onMouseEnter={() => setShowVolumeSlider(true)}
              onMouseLeave={handleVolumeMouseLeave}
            >
              <button
                type='button'
                onClick={handleMuteToggle}
                className='flex items-center justify-center w-8 h-8 text-[#757575] hover:opacity-80'
                aria-label={volume === 0 ? 'Unmute' : 'Mute'}
              >
                {volume === 0 ? (
                  <Icon name='project-mute-icon' width={14} height={14} color='#757575' />
                ) : (
                  <Icon name='project-volume-icon' width={14} height={14} color='#757575' />
                )}
              </button>
              {showVolumeSlider && (
                <div
                  ref={volumePopoverRef}
                  className='absolute bottom-full left-1/2 -translate-x-1/2 p-1.5 rounded bg-black/70'
                >
                  <div className='h-[60px] px-1'>
                    <Slider
                      min={0}
                      max={1}
                      step={0.01}
                      value={volume}
                      onChange={handleVolumeChange}
                      vertical
                      className='!m-0 w-full'
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CanvasAudioWaveform;