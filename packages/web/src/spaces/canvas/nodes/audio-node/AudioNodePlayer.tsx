/**
 * Audio node content: waveform + toolbar (download / @) + playback bar.
 * Playback controls follow the same style as VideoNodeContent.
 */
import React, { memo, useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/ui/icon';
import Slider from '@/ui/slider';
import { useWavesurfer } from '@wavesurfer/react';

export interface AudioNodePlayerProps {
  src: string;
  /** Show bottom toolbar only when selected. */
  selected?: boolean;
  /** Show top quick-action bar (download / @). */
  showQuickActions?: boolean;
  onDownloadClick?: (e: React.MouseEvent) => void;
  onMentionClick?: (e: React.MouseEvent) => void;
}

const toolbarBarClass = 'flex items-center gap-[2px] rounded-[4px] bg-white/80 p-[4px] shadow-sm nodrag';
const toolbarBtnClass =
  'flex h-[22px] w-[22px] items-center justify-center rounded-[4px] text-text-default-secondary hover:bg-black/5';

const formatTime = (seconds: number) => {
  const s = Math.floor(seconds);
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const AudioNodePlayer: React.FC<AudioNodePlayerProps> = ({
  src,
  selected = false,
  showQuickActions = true,
  onDownloadClick,
  onMentionClick,
}) => {
  const { t } = useTranslation();
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
    waveColor: 'var(--color-text-disabled-base)',
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

  const handleDownload = async () => {
    if (!src) return;
    try {
      const res = await fetch(src, { mode: 'cors' });
      if (!res.ok) throw new Error(res.statusText);
      const blob = await res.blob();
      const urlPath = src.split('?')[0].split('#')[0];
      const fileName = urlPath.split('/').pop() || `audio_${Date.now()}.mp3`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.error('Failed to download audio:', e);
    }
  };

  return (
    <div className='w-full h-full min-h-0 flex flex-col items-stretch justify-center overflow-hidden rounded-[8px] bg-background-default-base relative'>
      {/* Top: waveform */}
      <div className='flex-1 flex items-center px-3 pt-3 pb-1 min-h-[80px]' onMouseDown={stopPropagation}>
        <div ref={containerRef} className='w-full h-[48px]' />
      </div>

      {/* Toolbar: download / @ (visible when selected) */}
      {selected && showQuickActions && (
        <div className='px-3 pb-1 nodrag' onMouseDown={stopPropagation}>
          <div className='flex justify-center'>
            <div className={toolbarBarClass}>
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload();
                  onDownloadClick?.(e);
                }}
                className={toolbarBtnClass}
                aria-label={t('common.download', 'Download')}
              >
                <Icon name='project-chat-download-icon' width={20} height={20} color='var(--color-icon-secondary)' />
              </button>
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation();
                  onMentionClick?.(e);
                }}
                className={toolbarBtnClass}
                aria-label={t('common.mention', 'Mention')}
              >
                <Icon name='project-chat-mention-icon' width={15} height={15} color='var(--color-icon-secondary)' />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Playback bar: play/pause, time, progress, duration, volume (selected only) */}
      {selected && (
        <div className='px-3 pb-2 nodrag' onMouseDown={stopPropagation}>
          <div className='w-full'>
            <div className='flex items-center w-full gap-2 py-1'>
              <button
                type='button'
                onClick={handlePlayPause}
                className='flex-shrink-0 flex items-center justify-center w-8 h-8 nodrag text-icon-base hover:opacity-80'
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? (
                  <Icon name='project-pause-audio-icon' width={10} height={10} color='var(--color-icon-base)' />
                ) : (
                  <Icon name='project-play-audio-icon' width={10} height={12} color='var(--color-icon-base)' />
                )}
              </button>
              <span className='flex-shrink-0 text-[12px] text-icon-base font-normal tabular-nums'>
                {formatTime(currentTime)}
              </span>
              <div className='flex-1 min-w-0 h-8 flex items-center' onClick={stopPropagation}>
                <div className='w-full flex items-center'>
                  <Slider
                    min={0}
                    max={100}
                    step={0.1}
                    value={progress}
                    onChange={handleProgressChange}
                    className='nodrag !m-0 w-full block'
                  />
                </div>
              </div>
              <span className='flex-shrink-0 text-[12px] text-icon-base font-normal tabular-nums'>
                {formatTime(duration)}
              </span>
              <div
                className='relative flex-shrink-0 nodrag'
                onMouseEnter={() => setShowVolumeSlider(true)}
                onMouseLeave={handleVolumeMouseLeave}
              >
                <button
                  type='button'
                  onClick={handleMuteToggle}
                  className='flex items-center justify-center w-8 h-8 nodrag text-text-default-secondary hover:opacity-80'
                  aria-label={volume === 0 ? 'Unmute' : 'Mute'}
                >
                  {volume === 0 ? (
                    <Icon name='project-mute-icon' width={14} height={14} color='var(--color-icon-secondary)' />
                  ) : (
                    <Icon name='project-volume-icon' width={14} height={14} color='var(--color-icon-secondary)' />
                  )}
                </button>
                {showVolumeSlider && (
                  <div
                    ref={volumePopoverRef}
                    className='absolute bottom-full left-1/2 -translate-x-1/2 p-1.5 rounded bg-black/70 nodrag'
                  >
                    <div className='h-[60px] px-1'>
                      <Slider
                        min={0}
                        max={1}
                        step={0.01}
                        value={volume}
                        onChange={handleVolumeChange}
                        vertical
                        className='nodrag !m-0 w-full'
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default memo(AudioNodePlayer);
