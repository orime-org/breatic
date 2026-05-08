import React, { useState, memo } from 'react';
import Slider from '@/ui/slider';
import { ColorPicker } from '@/ui/colorPicker';
import Input from '@/ui/input';
import { useTranslation } from 'react-i18next';
import { MediaItem, TimelineClip } from '../../types';
import { useVideoEditorStore } from '@/app/hooks/useVideoEditorStore';
import CropModal from './CropModal';
import { Icon } from '@/ui/icon';

interface ImageStylePanelProps {
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

const ImageStylePanel: React.FC<ImageStylePanelProps> = () => {
  const { t } = useTranslation();
  const { clips, mediaItems, selectedClipId, batchUpdateClips, setSelectedClipId } = useVideoEditorStore();
  const [cropModalVisible, setCropModalVisible] = useState(false);

  // getallselected clips（same type ）
  const selectedClips = selectedClipId.length > 0
    ? selectedClipId.map((id) => clips.find((c: TimelineClip) => c.id === id)).filter(Boolean) as TimelineClip[]
    : [];

  const selectedClip = selectedClips[0] || null;

  const mediaItem = ((): MediaItem | null => {
    if (!selectedClip) return null;
    return mediaItems.find((item: MediaItem) => item.id === selectedClip.mediaId) || null;
  })();

  if (!selectedClip || !mediaItem) {
    return null;
  }

  const mediaStyle = selectedClip.mediaStyle || {};

  // batchupdateallselected clips style
  const updateMediaStyle = (updates: Partial<typeof mediaStyle>) => {
    // usebatchupdate， updateallselected clips
    const updatedClips = clips.map((clip) => {
      if (selectedClipId.includes(clip.id)) {
        const currentMediaStyle = clip.mediaStyle || {};
        const newMediaStyle = { ...currentMediaStyle, ...updates };
        return { ...clip, mediaStyle: newMediaStyle };
      }
      return clip;
    });
    batchUpdateClips(updatedClips);
  };

  // batchupdateallselected clips
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

  const handleImageCropApply = (
    _croppedImageUrl: string | null,
    cropData: {
      x: number;
      y: number;
      width: number;
      height: number;
      unit: 'px';
    }
  ) => {
    const canvasElement = document.getElementById('preview-canvas-bg');
    const canvasWidth = canvasElement ? parseFloat(canvasElement.getAttribute('data-width') || '1920') : 1920;
    const canvasHeight = canvasElement ? parseFloat(canvasElement.getAttribute('data-height') || '1080') : 1080;
    const maxWidth = canvasWidth * 0.5;
    const maxHeight = canvasHeight * 0.5;
    const referenceMediaWidth = mediaItem?.width || cropData.width;
    const referenceMediaHeight = mediaItem?.height || cropData.height;

    const updatedClips = clips.map((clip) => {
      if (!selectedClipId.includes(clip.id)) {
        return clip;
      }

      const clipMedia = mediaItems.find((item) => item.id === clip.mediaId);
      const targetMediaWidth = clipMedia?.width || referenceMediaWidth;
      const targetMediaHeight = clipMedia?.height || referenceMediaHeight;
      const scaleToTargetX = targetMediaWidth / referenceMediaWidth;
      const scaleToTargetY = targetMediaHeight / referenceMediaHeight;
      const scaledCropData = {
        x: cropData.x * scaleToTargetX,
        y: cropData.y * scaleToTargetY,
        width: cropData.width * scaleToTargetX,
        height: cropData.height * scaleToTargetY,
        unit: 'px' as const,
      };
      const cropRatio = scaledCropData.width / scaledCropData.height;

      let newWidth: number;
      let newHeight: number;
      if (clip.width && clip.height) {
        const currentArea = clip.width * clip.height;
        newHeight = Math.sqrt(currentArea / cropRatio);
        newWidth = newHeight * cropRatio;
      } else {
        const mediaRatio = targetMediaWidth / targetMediaHeight;
        let originalDisplayWidth: number;
        let originalDisplayHeight: number;
        if (targetMediaWidth > maxWidth || targetMediaHeight > maxHeight) {
          if (mediaRatio > maxWidth / maxHeight) {
            originalDisplayWidth = maxWidth;
            originalDisplayHeight = maxWidth / mediaRatio;
          } else {
            originalDisplayHeight = maxHeight;
            originalDisplayWidth = maxHeight * mediaRatio;
          }
        } else {
          originalDisplayWidth = targetMediaWidth;
          originalDisplayHeight = targetMediaHeight;
        }
        const cropWidthRatio = scaledCropData.width / targetMediaWidth;
        const cropHeightRatio = scaledCropData.height / targetMediaHeight;
        newWidth = originalDisplayWidth * cropWidthRatio;
        newHeight = originalDisplayHeight * cropHeightRatio;
      }

      return {
        ...clip,
        cropArea: scaledCropData,
        width: newWidth,
        height: newHeight,
      };
    });

    batchUpdateClips(updatedClips);
  };

  return (
    <>
      <div className='flex items-center justify-between'>
        <div className='font-semibold text-xs text-text-default-secondary'>
          {t('toolbar.image') || 'Image'}
        </div>
        <button onClick={() => setSelectedClipId([])} className='text-gray-400 hover:text-gray-600'>
          <Icon name='videoEditor-close-icon' width={12} height={12} />
        </button>
      </div>
      <div className='space-y-4'>
        {/* cropbutton */} <div className='flex items-center py-3 border-b border-border-default-base'> <div className='p-1.5 rounded outline outline-1 outline-offset-[-1px] outline-border-default-base inline-flex justify-start items-center gap-3 cursor-pointer' onClick={() => setCropModalVisible(true)} > <Icon name='videoEditor-crop-icon' width={16} height={16} color='var(--color-icon-base)' /> </div> </div> {/* Basic */} <div> <h4 className='mb-3 font-semibold text-text-default-secondary text-xs'> {t('imageStyle.title') || 'Basic'} </h4> <div className='space-y-3'> <div className='flex items-center justify-between'> <div className='text-text-default-tertiary text-xs flex-1'> {t('imageStyle.borderRadius') || 'Border Radius'} </div> <div className='flex items-center gap-2 w-[130px]'> <Input value={String(mediaStyle.borderRadius ?? 0)} onChange={(e) => { const val = parseFloat(e.target.value); if (!isNaN(val)) { updateMediaStyle({ borderRadius: Math.max(0, Math.min(100, val)) }); } }} onBlur={(e) => { const val = parseFloat(e.target.value); const finalValue = isNaN(val) ? 0 : Math.max(0, Math.min(100, val)); updateMediaStyle({ borderRadius: finalValue }); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} className='text-center w-[35px] h-[26px] text-xs p-1 rounded' /> <div className='flex-1 pr-2.5'> <Slider className={sliderClass} value={mediaStyle.borderRadius || 0} onChange={(value) => { updateMediaStyle({ borderRadius: value }); }} min={0} max={100} {...sliderBaseProps} /> </div> </div> </div> <div className='flex items-center justify-between'> <div className='text-text-default-tertiary text-xs flex-1'> {t('imageStyle.opacity') || 'Opacity'} </div> <div className='flex items-center gap-2 w-[130px]'> <Input value={String(selectedClip.opacity ?? 100)} onChange={(e) => { const val = parseFloat(e.target.value); if (!isNaN(val)) { updateOpacity(Math.max(0, Math.min(100, val))); } }} onBlur={(e) => { const val = parseFloat(e.target.value); const finalValue = isNaN(val) ? 100 : Math.max(0, Math.min(100, val)); updateOpacity(finalValue); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} className='text-center w-[35px] h-[26px] text-xs p-1 rounded' /> <div className='flex-1 pr-2.5'> <Slider className={sliderClass} value={selectedClip.opacity ?? 100} onChange={(value) => { updateOpacity(value); }} min={0} max={100} {...sliderBaseProps} /> </div> </div> </div> </div> </div> {/* Filter */} <div className='pt-3 mt-3 border-t border-border-default-base'> <h4 className='mb-3 font-semibold text-text-default-secondary text-xs'> {t('imageStyle.filter') || 'Filter'} </h4> <div className='space-y-3'> <div className='flex items-center justify-between'> <div className='text-text-default-tertiary text-xs flex-1'> {t('imageStyle.blur') || 'Blur'} </div> <div className='flex items-center gap-2 w-[130px]'> <Input value={String(mediaStyle.blur ?? 0)} onChange={(e) => { const val = parseFloat(e.target.value); if (!isNaN(val)) { updateMediaStyle({ blur: Math.max(0, Math.min(100, val)) }); } }} onBlur={(e) => { const val = parseFloat(e.target.value); const finalValue = isNaN(val) ? 0 : Math.max(0, Math.min(100, val)); updateMediaStyle({ blur: finalValue }); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} className='text-center w-[35px] h-[26px] text-xs p-1 rounded' /> <div className='flex-1 pr-2.5'> <Slider className={sliderClass} value={mediaStyle.blur || 0} onChange={(value) => { updateMediaStyle({ blur: value }); }} min={0} max={100} {...sliderBaseProps} /> </div> </div> </div> <div className='flex items-center justify-between'> <div className='text-text-default-tertiary text-xs flex-1'> {t('imageStyle.brightness') || 'Brightness'} </div> <div className='flex items-center gap-2 w-[130px]'> <Input value={String(mediaStyle.brightness ?? 100)} onChange={(e) => { const val = parseFloat(e.target.value); if (!isNaN(val)) { updateMediaStyle({ brightness: Math.max(0, Math.min(200, val)) }); } }} onBlur={(e) => { const val = parseFloat(e.target.value); const finalValue = isNaN(val) ? 100 : Math.max(0, Math.min(200, val)); updateMediaStyle({ brightness: finalValue }); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} className='text-center w-[35px] h-[26px] text-xs p-1 rounded' /> <div className='flex-1 pr-2.5'> <Slider className={sliderClass} value={mediaStyle.brightness || 100} onChange={(value) => { updateMediaStyle({ brightness: value }); }} min={0} max={200} {...sliderBaseProps} /> </div> </div> </div> </div> </div> {/* Outline */} <div className='pt-3 mt-3 border-t border-border-default-base'> <h4 className='mb-3 font-semibold text-text-default-secondary text-xs'> {t('imageStyle.outline') || 'Outline'} </h4> <div className='space-y-3'> <div className='flex items-center justify-between'> <div className='text-text-default-tertiary text-xs flex-1'> {t('imageStyle.outlineColor') || 'Outline Color'} </div> <div className='w-[130px]'> <ColorPicker value={mediaStyle.outlineColor || '#000000'} onChange={(color) => updateMediaStyle({ outlineColor: color })} showText className='w-full justify-start px-[7px] h-[26px]' /> </div> </div> <div className='flex items-center justify-between'> <div className='text-text-default-tertiary text-xs flex-1'> {t('imageStyle.outlineWidth') || 'Outline Width'} </div> <Input inputType='number' value={String(mediaStyle.outlineWidth ?? 0)} onChange={(e) => { const val = parseFloat(e.target.value); if (!isNaN(val)) { updateMediaStyle({ outlineWidth: Math.max(0, val) }); } }} onBlur={(e) => { const val = parseFloat(e.target.value); const finalValue = isNaN(val) ? 0 : Math.max(0, val); updateMediaStyle({ outlineWidth: finalValue }); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} className='w-[130px] h-[26px]' size='small' /> </div> </div> </div> {/* Shadow */} <div className='pt-3 mt-3 border-t border-border-default-base'> <h4 className='mb-3 font-semibold text-text-default-secondary text-xs'> {t('imageStyle.shadow') || 'Shadow'} </h4> <div className='space-y-3'> <div className='flex items-center justify-between'> <div className='text-text-default-tertiary text-xs flex-1'> {t('imageStyle.shadowColor') || 'Shadow Color'} </div> <div className='w-[130px]'> <ColorPicker value={mediaStyle.shadowColor || '#000000'} onChange={(color) => updateMediaStyle({ shadowColor: color })} size='small' showText className='w-full justify-start px-[7px] h-[26px]' /> </div> </div> <div className='flex items-center justify-between'> <div className='text-text-default-tertiary text-xs flex-1'> {t('imageStyle.shadowX') || 'Shadow X'} </div> <Input inputType='number' value={String(mediaStyle.shadowOffsetX ?? 0)} onChange={(e) => { const val = parseFloat(e.target.value); if (!isNaN(val)) { updateMediaStyle({ shadowOffsetX: val }); } }} onBlur={(e) => { const val = parseFloat(e.target.value); const finalValue = isNaN(val) ? 0 : val; updateMediaStyle({ shadowOffsetX: finalValue }); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} className='w-[130px] h-[26px]' size='small' /> </div> <div className='flex items-center justify-between'> <div className='text-text-default-tertiary text-xs flex-1'> {t('imageStyle.shadowY') || 'Shadow Y'} </div> <Input inputType='number' value={String(mediaStyle.shadowOffsetY ?? 0)} onChange={(e) => { const val = parseFloat(e.target.value); if (!isNaN(val)) { updateMediaStyle({ shadowOffsetY: val }); } }} onBlur={(e) => { const val = parseFloat(e.target.value); const finalValue = isNaN(val) ? 0 : val; updateMediaStyle({ shadowOffsetY: finalValue }); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} className='w-[130px] h-[26px]' size='small' /> </div> <div className='flex items-center justify-between'> <div className='text-text-default-tertiary text-xs flex-1'> {t('imageStyle.shadowBlur') || 'Shadow Blur'} </div> <Input inputType='number' value={String(mediaStyle.shadowBlur ?? 0)} onChange={(e) => { const val = parseFloat(e.target.value); if (!isNaN(val)) { updateMediaStyle({ shadowBlur: Math.max(0, val) }); } }} onBlur={(e) => { const val = parseFloat(e.target.value); const finalValue = isNaN(val) ? 0 : Math.max(0, val); updateMediaStyle({ shadowBlur: finalValue }); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} className='w-[130px] h-[26px]' size='small' /> </div> </div> </div> </div> {/* crop */}
      <CropModal
        visible={cropModalVisible}
        mediaUrl={mediaItem.url || ''}
        mediaType='image'
        mediaWidth={mediaItem.width}
        mediaHeight={mediaItem.height}
        existingCrop={selectedClip.cropArea}
        onClose={() => setCropModalVisible(false)}
        onApply={handleImageCropApply}
      />
    </>
  );
};

export default memo(ImageStylePanel);
