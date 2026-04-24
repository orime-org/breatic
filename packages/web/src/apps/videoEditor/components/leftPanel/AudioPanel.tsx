import React, { memo } from 'react';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/base/icon';
import type { TimelineClip, MediaItem } from '../../types';

interface AudioPanelProps {
  nodeId?: string;
  currentTime?: number;
}

/**
 * AudioPanel component - audiopanel
 */
const AudioPanel: React.FC<AudioPanelProps> = ({ currentTime = 0 }) => {
  const { t } = useTranslation();
  const { mediaItems, addClip } = useVideoEditorStore();

  const audioItems = mediaItems.filter((item: MediaItem) => item.type === 'audio');

  const handleMediaClick = (item: MediaItem) => {
    const mediaDuration = item.duration || 5;
    const clip: TimelineClip = {
      id: `clip-${Date.now()}-${Math.random()}`,
      mediaId: item.id,
      type: 'audio',
      start: currentTime,
      end: currentTime + mediaDuration,
      trackIndex: 0,
      trimStart: 0,
      trimEnd: mediaDuration,
    };

    // use addClip， automaticallyselected asset
    addClip(clip);
  };

  const formatDuration = (seconds: number): string => {
    const total = Math.floor(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  if (audioItems.length === 0) {
    return null;
  }

  return (
    <div className='flex flex-col'>
      <div className='p-2.5'>
        <div className='mb-2.5 text-xs font-semibold text-text-default-secondary'>{t('toolbar.audio')}</div>
      </div>
      <div className='px-2.5 pb-2.5'>
        <div className='flex flex-col gap-2.5'>
          {audioItems.map((item: MediaItem) => (
            <div
              key={item.id}
              className='relative overflow-hidden border border-border-default-base cursor-pointer group hover:border-blue-400 rounded h-10'
              onClick={() => handleMediaClick(item)}
            >
              <div className='flex items-center w-full h-full'>
                <div className='flex items-center justify-center text-xl text-text-default-tertiary shrink-0 bg-background-default-secondary w-10 h-10'>
                  <Icon
                    name='videoEditor-audio-icon'
                    width={14}
                    height={14}
                    color='var(--color-icon-secondary)'
                  />
                </div>
                <div className='flex-1 min-w-0 font-medium text-text-default-tertiary text-xs px-2.5'>
                  <div className='truncate' title={item.name}>
                    {item.name}
                  </div>
                </div>
                {item.duration && (
                  <div className='px-2 text-xs text-text-default-tertiary'>
                    {formatDuration(item.duration)}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default memo(AudioPanel);

