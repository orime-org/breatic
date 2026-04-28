import React, { useState, memo } from 'react';
import Slider from '@/components/base/slider';
import { ColorPicker } from '@/components/base/colorPicker';
import Input from '@/components/base/input';
import { useTranslation } from 'react-i18next';
import { MediaItem } from '../../types';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
import CropModal from './CropModal';
import { Icon } from '@/components/base/icon';

interface VideoStylePanelProps {
  nodeId?: string;
}

interface CropData {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: 'px';
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

const VideoStylePanel: React.FC<VideoStylePanelProps> = () => {
  const { t } = useTranslation();
  const { clips, mediaItems, selectedClipId, updateClip, batchUpdateClips, setSelectedClipId } = useVideoEditorStore();
  const [cropModalVisible, setCropModalVisible] = useState(false);

  // getallselected clips（same type ）
  const selectedClips = selectedClipId.length > 0
    ? selectedClipId.map((id) => clips.find((c: { id: string }) => c.id === id)).filter(Boolean) as typeof clips
    : [];

  const selectedClip = selectedClips[0] || null;

  const mediaItem = ((): MediaItem | null => {
    if (!selectedClip) return null;
    return mediaItems.find((item: MediaItem) => item.id === selectedClip.mediaId) || null;
  })();

  if (!selectedClip || !mediaItem) {
    return null;
  }

  // batchupdateallselected clips
  const updateMediaStyle = (updates: Partial<typeof selectedClip.mediaStyle>) => {
    // usebatchupdate， updateallselected clips
    const updatedClips = clips.map((clip) => {
      if (selectedClipId.includes(clip.id)) {
        const newMediaStyle = { ...(clip.mediaStyle || {}), ...updates };
        return { ...clip, mediaStyle: newMediaStyle };
      }
      return clip;
    });
    batchUpdateClips(updatedClips);
  };

  const updateVolume = (value: number) => {
    // usebatchupdate， updateallselected clips
    const updatedClips = clips.map((clip) => {
      if (selectedClipId.includes(clip.id)) {
        return { ...clip, volume: value };
      }
      return clip;
    });
    batchUpdateClips(updatedClips);
  };

  const updateOpacity = (value: number) => {
    // usebatchupdate， updateallselected clips
    const updatedClips = clips.map((clip) => {
      if (selectedClipId.includes(clip.id)) {
        return { ...clip, opacity: value };
      }
      return clip;
    });
    batchUpdateClips(updatedClips);
  };

  const updateSpeed = (value: number) => {
    // usebatchupdate， updateallselected clips
    const updatedClips = clips.map((clip) => {
      if (selectedClipId.includes(clip.id)) {
        return { ...clip, speed: value };
      }
      return clip;
    });
    batchUpdateClips(updatedClips);
  };

  const handleClosePanel = () => {
    setSelectedClipId([]);
  };

  const handleOpenCropModal = () => {
    setCropModalVisible(true);
  };

  const handleCloseCropModal = () => {
    setCropModalVisible(false);
  };

  const handleInputEnterBlur = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) {
      updateVolume(Math.max(0, Math.min(100, val)));
    }
  };

  const handleVolumeBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const finalValue = isNaN(val) ? 100 : Math.max(0, Math.min(100, val));
    updateVolume(finalValue);
  };

  const handleOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) {
      updateOpacity(Math.max(0, Math.min(100, val)));
    }
  };

  const handleOpacityBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const finalValue = isNaN(val) ? 100 : Math.max(0, Math.min(100, val));
    updateOpacity(finalValue);
  };

  const handleSpeedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) {
      updateSpeed(Math.max(0.25, Math.min(4, val)));
    }
  };

  const handleSpeedBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const finalValue = isNaN(val) ? 1 : Math.max(0.25, Math.min(4, val));
    updateSpeed(finalValue);
  };

  const handleBrightnessChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) {
      updateMediaStyle({ brightness: Math.max(0, Math.min(200, val)) });
    }
  };

  const handleBrightnessBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const finalValue = isNaN(val) ? 100 : Math.max(0, Math.min(200, val));
    updateMediaStyle({ brightness: finalValue });
  };

  const handleBrightnessSlider = (value: number) => {
    updateMediaStyle({ brightness: value });
  };

  const handleBlurChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) {
      updateMediaStyle({ blur: Math.max(0, Math.min(100, val)) });
    }
  };

  const handleBlurBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const finalValue = isNaN(val) ? 0 : Math.max(0, Math.min(100, val));
    updateMediaStyle({ blur: finalValue });
  };

  const handleBlurSlider = (value: number) => {
    updateMediaStyle({ blur: value });
  };

  const handleBorderRadiusChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) {
      updateMediaStyle({ borderRadius: Math.max(0, Math.min(100, val)) });
    }
  };

  const handleBorderRadiusBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const finalValue = isNaN(val) ? 0 : Math.max(0, Math.min(100, val));
    updateMediaStyle({ borderRadius: finalValue });
  };

  const handleBorderRadiusSlider = (value: number) => {
    updateMediaStyle({ borderRadius: value });
  };

  const handleOutlineColorChange = (color: string) => {
    updateMediaStyle({ outlineColor: color });
  };

  const handleOutlineWidthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) {
      updateMediaStyle({ outlineWidth: Math.max(0, val) });
    }
  };

  const handleOutlineWidthBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const finalValue = isNaN(val) ? 0 : Math.max(0, val);
    updateMediaStyle({ outlineWidth: finalValue });
  };

  const handleShadowColorChange = (color: string) => {
    updateMediaStyle({ shadowColor: color });
  };

  const handleShadowOffsetXChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) {
      updateMediaStyle({ shadowOffsetX: val });
    }
  };

  const handleShadowOffsetXBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const finalValue = isNaN(val) ? 0 : val;
    updateMediaStyle({ shadowOffsetX: finalValue });
  };

  const handleShadowOffsetYChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) {
      updateMediaStyle({ shadowOffsetY: val });
    }
  };

  const handleShadowOffsetYBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const finalValue = isNaN(val) ? 0 : val;
    updateMediaStyle({ shadowOffsetY: finalValue });
  };

  const handleShadowBlurChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) {
      updateMediaStyle({ shadowBlur: Math.max(0, val) });
    }
  };

  const handleShadowBlurBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const finalValue = isNaN(val) ? 0 : Math.max(0, val);
    updateMediaStyle({ shadowBlur: finalValue });
  };

  const handleCropApply = (_croppedUrl: string | null, cropData: CropData) => {
    // videocrop：container ， cropregion
    const currentWidth = selectedClip.width;
    const currentHeight = selectedClip.height;

    // calculatecropregion
    const cropRatio = cropData.width / cropData.height;

    let newWidth;
    let newHeight;

    if (currentWidth && currentHeight) {
      // container：keep ， cropregion ratio
      const currentArea = currentWidth * currentHeight;
      newHeight = Math.sqrt(currentArea / cropRatio);
      newWidth = newHeight * cropRatio;
    } else {
      // first timecrop： MediaElement default calculatelogic
      const canvasElement = document.getElementById('preview-canvas-bg');
      let canvasWidth = 1920;
      let canvasHeight = 1080;

      if (canvasElement) {
        canvasWidth = parseFloat(canvasElement.getAttribute('data-width') || '1920');
        canvasHeight = parseFloat(canvasElement.getAttribute('data-height') || '1080');
      }

      const maxWidth = canvasWidth * 0.5;
      const maxHeight = canvasHeight * 0.5;
      const mediaWidth = mediaItem?.width || cropData.width;
      const mediaHeight = mediaItem?.height || cropData.height;
      const mediaRatio = mediaWidth / mediaHeight;

      // calculatevideo crop defaultdisplay
      let originalDisplayWidth: number;
      let originalDisplayHeight: number;
      if (mediaWidth > maxWidth || mediaHeight > maxHeight) {
        // original canvas50%，need toscale
        if (mediaRatio > maxWidth / maxHeight) {
          originalDisplayWidth = maxWidth;
          originalDisplayHeight = maxWidth / mediaRatio;
        } else {
          originalDisplayHeight = maxHeight;
          originalDisplayWidth = maxHeight * mediaRatio;
        }
      } else {
        // original canvas50%，useoriginal
        originalDisplayWidth = mediaWidth;
        originalDisplayHeight = mediaHeight;
      }

      // calculatecropratio（cropregion originalvideo ratio）
      const cropWidthRatio = cropData.width / mediaWidth;
      const cropHeightRatio = cropData.height / mediaHeight;

      // crop container = defaultdisplay × cropratio
      newWidth = originalDisplayWidth * cropWidthRatio;
      newHeight = originalDisplayHeight * cropHeightRatio;
    }

    // CSS crop coordinate， croppedUrl（ imagecropkeepconsistent）
    updateClip(selectedClip.id, {
      cropArea: cropData,
      width: newWidth,
      height: newHeight,
    });
  };

  return (
    <>
      <div className='flex items-center justify-between'>
        <div className='font-semibold text-xs text-text-default-secondary'>
          {t('toolbar.video') || 'Video'}
        </div>
        <button onClick={handleClosePanel} className='text-gray-400 hover:text-gray-600'>
          <Icon name='videoEditor-close-icon' width={12} height={12} />
        </button>
      </div>
      <div className='space-y-4'>
        {/* cropbutton */}
        <div className='flex items-center py-3 border-b border-border-default-base'>
          <div
            className='p-1.5 rounded outline outline-1 outline-offset-[-1px] outline-border-default-base inline-flex justify-start items-center gap-3 cursor-pointer'
            onClick={handleOpenCropModal}
          >
            <Icon
              name='videoEditor-crop-icon'
              width={16}
              height={16}
              color='var(--color-icon-base)'
            />
          </div>
        </div>

        {/* Basic */}
        <div>
          <h4 className='mb-3 font-semibold text-text-default-secondary text-xs'>
            {t('videoStyle.title') || 'Basic'}
          </h4>
          <div className='space-y-3'>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('videoStyle.volume') || 'Volume'}
              </div>
              <div className='flex items-center gap-2 w-[130px]'>
                <Input
                  value={String(selectedClip.volume ?? 100)}
                  onChange={handleVolumeChange}
                  onBlur={handleVolumeBlur}
                  onKeyDown={handleInputEnterBlur}
                  className='text-center w-[35px] h-[26px] text-xs p-1 rounded'
                />
                <div className='flex-1 pr-2.5'>
                  <Slider
                    className={sliderClass}
                    value={selectedClip.volume ?? 100}
                    onChange={updateVolume}
                    min={0}
                    max={100}
                    {...sliderBaseProps}
                  />
                </div>
              </div>
            </div>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('videoStyle.opacity') || 'Opacity'}
              </div>
              <div className='flex items-center gap-2 w-[130px]'>
                <Input
                  value={String(selectedClip.opacity ?? 100)}
                  onChange={handleOpacityChange}
                  onBlur={handleOpacityBlur}
                  onKeyDown={handleInputEnterBlur}
                  className='text-center w-[35px] h-[26px] text-xs p-1 rounded'
                />
                <div className='flex-1 pr-2.5'>
                  <Slider
                    className={sliderClass}
                    value={selectedClip.opacity ?? 100}
                    onChange={updateOpacity}
                    min={0}
                    max={100}
                    {...sliderBaseProps}
                  />
                </div>
              </div>
            </div>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('videoStyle.speed') || 'Speed'}
              </div>
              <div className='flex items-center gap-2 w-[130px]'>
                <Input
                  value={String(selectedClip.speed ?? 1)}
                  onChange={handleSpeedChange}
                  onBlur={handleSpeedBlur}
                  onKeyDown={handleInputEnterBlur}
                  className='text-center w-[35px] h-[26px] text-xs p-1 rounded'
                />
                <div className='flex-1 pr-2.5'>
                  <Slider
                    className={sliderClass}
                    value={selectedClip.speed ?? 1}
                    onChange={updateSpeed}
                    min={0.25}
                    max={4}
                    step={0.25}
                    {...sliderBaseProps}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Filter */}
        <div className='pt-3 mt-3 border-t border-border-default-base'>
          <h4 className='mb-3 font-semibold text-text-default-secondary text-xs'>
            {t('videoStyle.filter') || 'Filter'}
          </h4>
          <div className='space-y-3'>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('videoStyle.brightness') || 'Brightness'}
              </div>
              <div className='flex items-center gap-2 w-[130px]'>
                <Input
                  value={String(selectedClip.mediaStyle?.brightness ?? 100)}
                  onChange={handleBrightnessChange}
                  onBlur={handleBrightnessBlur}
                  onKeyDown={handleInputEnterBlur}
                  className='text-center w-[35px] h-[26px] text-xs p-1 rounded'
                />
                <div className='flex-1 pr-2.5'>
                  <Slider
                    className={sliderClass}
                    value={selectedClip.mediaStyle?.brightness ?? 100}
                    onChange={handleBrightnessSlider}
                    min={0}
                    max={200}
                    {...sliderBaseProps}
                  />
                </div>
              </div>
            </div>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('videoStyle.blur') || 'Blur'}
              </div>
              <div className='flex items-center gap-2 w-[130px]'>
                <Input
                  value={String(selectedClip.mediaStyle?.blur ?? 0)}
                  onChange={handleBlurChange}
                  onBlur={handleBlurBlur}
                  onKeyDown={handleInputEnterBlur}
                  className='text-center w-[35px] h-[26px] text-xs p-1 rounded'
                />
                <div className='flex-1 pr-2.5'>
                  <Slider
                    className={sliderClass}
                    value={selectedClip.mediaStyle?.blur ?? 0}
                    onChange={handleBlurSlider}
                    min={0}
                    max={100}
                    {...sliderBaseProps}
                  />
                </div>
              </div>
            </div>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('videoStyle.borderRadius') || 'Border Radius'}
              </div>
              <div className='flex items-center gap-2 w-[130px]'>
                <Input
                  value={String(selectedClip.mediaStyle?.borderRadius ?? 0)}
                  onChange={handleBorderRadiusChange}
                  onBlur={handleBorderRadiusBlur}
                  onKeyDown={handleInputEnterBlur}
                  className='text-center w-[35px] h-[26px] text-xs p-1 rounded'
                />
                <div className='flex-1 pr-2.5'>
                  <Slider
                    className={sliderClass}
                    value={selectedClip.mediaStyle?.borderRadius ?? 0}
                    onChange={handleBorderRadiusSlider}
                    min={0}
                    max={100}
                    {...sliderBaseProps}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Outline */}
        <div className='pt-3 mt-3 border-t border-border-default-base'>
          <h4 className='mb-3 font-semibold text-text-default-secondary text-xs'>
            {t('videoStyle.outline') || 'Outline'}
          </h4>
          <div className='space-y-3'>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('videoStyle.outlineColor') || 'Outline Color'}
              </div>
              <div className='w-[130px]'>
                <ColorPicker
                  value={selectedClip.mediaStyle?.outlineColor || '#000000'}
                  onChange={handleOutlineColorChange}
                  size='small'
                  showText
                  className='w-full justify-start px-[7px] h-[26px]'
                />
              </div>
            </div>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('videoStyle.outlineWidth') || 'Outline Width'}
              </div>
              <Input
                inputType='number'
                value={String(selectedClip.mediaStyle?.outlineWidth ?? 0)}
                onChange={handleOutlineWidthChange}
                onBlur={handleOutlineWidthBlur}
                onKeyDown={handleInputEnterBlur}
                className='w-[130px]'
                size='small'
              />
            </div>
          </div>
        </div>

        {/* Shadow */}
        <div className='pt-3 mt-3 border-t border-border-default-base'>
          <h4 className='mb-3 font-semibold text-text-default-secondary text-xs'>
            {t('videoStyle.shadow') || 'Shadow'}
          </h4>
          <div className='space-y-3'>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('videoStyle.shadowColor') || 'Shadow Color'}
              </div>
              <div className='w-[130px]'>
                <ColorPicker
                  value={selectedClip.mediaStyle?.shadowColor || '#000000'}
                  onChange={handleShadowColorChange}
                  size='small'
                  showText
                  className='w-full justify-start px-[7px] h-[26px]'
                />
              </div>
            </div>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('videoStyle.shadowX') || 'Shadow X'}
              </div>
              <Input
                inputType='number'
                value={String(selectedClip.mediaStyle?.shadowOffsetX ?? 0)}
                onChange={handleShadowOffsetXChange}
                onBlur={handleShadowOffsetXBlur}
                onKeyDown={handleInputEnterBlur}
                className='w-[130px]'
                size='small'
              />
            </div>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('videoStyle.shadowY') || 'Shadow Y'}
              </div>
              <Input
                inputType='number'
                value={String(selectedClip.mediaStyle?.shadowOffsetY ?? 0)}
                onChange={handleShadowOffsetYChange}
                onBlur={handleShadowOffsetYBlur}
                onKeyDown={handleInputEnterBlur}
                className='w-[130px]'
                size='small'
              />
            </div>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('videoStyle.shadowBlur') || 'Shadow Blur'}
              </div>
              <Input
                inputType='number'
                value={String(selectedClip.mediaStyle?.shadowBlur ?? 0)}
                onChange={handleShadowBlurChange}
                onBlur={handleShadowBlurBlur}
                onKeyDown={handleInputEnterBlur}
                className='w-[130px]'
                size='small'
              />
            </div>
          </div>
        </div>
      </div>
      {/* crop */}
      <CropModal
        visible={cropModalVisible}
        mediaUrl={mediaItem.url || ''}
        mediaType='video'
        mediaThumbnail={mediaItem.thumbnail}
        mediaWidth={mediaItem.width}
        mediaHeight={mediaItem.height}
        existingCrop={selectedClip.cropArea}
        onClose={handleCloseCropModal}
        onApply={handleCropApply}
      />
    </>
  );
};

export default memo(VideoStylePanel);
