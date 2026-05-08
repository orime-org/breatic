import React, { useEffect, useRef, useMemo, memo } from 'react';
import Slider from '@/ui/slider';
import Input from '@/ui/input';
import { Icon } from '@/ui/icon';
import { useTranslation } from 'react-i18next';
import { useVideoEditorStore } from '@/app/hooks/useVideoEditorStore';

const defaultVolume = 100;

interface AudioStylePanelProps {
  nodeId?: string;
}

const sliderClass = 'nodrag nopan !w-full';
const sliderBaseProps = {
  activeColor: '#5A5A5A',
  inactiveColor: '#E3E3E3',
  trackHeight: 6,
  thumbWidth: 20,
  thumbHeight: 16,
  thumbColor: '#B3B3B3',
} as const;

const AudioStylePanel: React.FC<AudioStylePanelProps> = () => {
  const { t } = useTranslation();
  const { clips, selectedClipId, updateClip, batchUpdateClips, setSelectedClipId } = useVideoEditorStore();
  const initializedRef = useRef<Set<string>>(new Set());

  // getallselected clips（same type ）
  const selectedClips = useMemo(() => {
    return selectedClipId.length > 0
      ? selectedClipId.map((id) => clips.find((c: { id: string }) => c.id === id)).filter(Boolean) as typeof clips
      : [];
  }, [selectedClipId, clips]);

  const selectedClip = selectedClips[0] || null;

  useEffect(() => {
    // initializeallselected clips volume
    selectedClips.forEach((clip) => {
      if (clip.volume === undefined && !initializedRef.current.has(clip.id)) {
        initializedRef.current.add(clip.id);
        updateClip(clip.id, { volume: defaultVolume });
      }
    });
  }, [selectedClips, updateClip]);

  if (!selectedClip) {
    return null;
  }

  const handleVolumeChange = (value: number) => {
    // usebatchupdate， updateallselected clips
    const updatedClips = clips.map((clip) => {
      if (selectedClipId.includes(clip.id)) {
        return { ...clip, volume: value };
      }
      return clip;
    });
    batchUpdateClips(updatedClips);
  };

  const handleSpeedChange = (value: number) => {
    // usebatchupdate， updateallselected clips
    const updatedClips = clips.map((clip) => {
      if (selectedClipId.includes(clip.id)) {
        const trimStart = clip.trimStart || 0;
        const trimEnd = clip.trimEnd || 0;
        const oldSpeed = clip.speed || 1;

        let audioDuration;
        if (trimEnd > 0) {
          audioDuration = trimEnd - trimStart;
        } else {
          audioDuration = (clip.end - clip.start) * oldSpeed;
        }

        const newTimelineDuration = audioDuration / value;
        const newEnd = clip.start + newTimelineDuration;

        return {
          ...clip,
          speed: value,
          end: newEnd,
        };
      }
      return clip;
    });
    batchUpdateClips(updatedClips);
  };

  return (
    <>
      <div className='flex items-center justify-between mb-4'>
        <h3 className='font-semibold text-xs text-text-default-secondary'>
          {t('audioStyle.title') || 'Audio Style'}
        </h3>
        <button onClick={() => setSelectedClipId([])} className='text-gray-400 hover:text-gray-600'>
          <Icon name='videoEditor-close-icon' width={12} height={12} />
        </button>
      </div>
      <div className='space-y-3'>
        {/* control */}
        <div className='flex items-center justify-between'>
          <div className='text-text-default-tertiary text-xs flex-1'>
            {t('audioStyle.volume') || 'Volume'}
          </div>
          <div className='flex items-center gap-2 w-[144px]'>
            <Input
              value={String(selectedClip.volume ?? defaultVolume)}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) {
                  handleVolumeChange(Math.max(0, Math.min(200, val)));
                }
              }}
              onBlur={(e) => {
                const val = parseFloat(e.target.value);
                const finalValue = isNaN(val) ? defaultVolume : Math.max(0, Math.min(200, val));
                handleVolumeChange(finalValue);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
              className='text-center w-[35px] h-[26px] text-xs p-1 rounded'
            />
            <div className='w-32 pr-2.5'>
              <Slider
                className={sliderClass}
                value={selectedClip.volume ?? defaultVolume}
                onChange={handleVolumeChange}
                min={0}
                max={200}
                {...sliderBaseProps}
              />
            </div>
          </div>
        </div>

        {/* control */}
        <div className='flex items-center justify-between'>
          <div className='text-text-default-tertiary text-xs flex-1'>
            {t('audioStyle.speed') || 'Speed'}
          </div>
          <div className='flex items-center gap-2 w-[144px]'>
            <Input
              value={String(selectedClip.speed ?? 1)}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) {
                  handleSpeedChange(Math.max(0.25, Math.min(4, val)));
                }
              }}
              onBlur={(e) => {
                const val = parseFloat(e.target.value);
                const finalValue = isNaN(val) ? 1 : Math.max(0.25, Math.min(4, val));
                handleSpeedChange(finalValue);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
              className='text-center w-[35px] h-[26px] text-xs p-1 rounded'
            />
            <div className='w-32 pr-2.5'>
              <Slider
                className={sliderClass}
                value={selectedClip.speed ?? 1}
                onChange={handleSpeedChange}
                min={0.25}
                max={4}
                step={0.25}
                {...sliderBaseProps}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default memo(AudioStylePanel);

