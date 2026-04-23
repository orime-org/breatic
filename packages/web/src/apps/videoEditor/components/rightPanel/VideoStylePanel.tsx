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

const sliderClass = 'nodrag nopan !w-full';
const sliderBaseProps = {
  activeColor: '#5A5A5A',
  inactiveColor: '#E3E3E3',
  trackHeight: 6,
  thumbWidth: 20,
  thumbHeight: 16,
  thumbColor: '#B3B3B3',
} as const;

const VideoStylePanel: React.FC<VideoStylePanelProps> = ({ nodeId }) => {
  const { t } = useTranslation();
  const { clips, mediaItems, selectedClipId, updateClip, batchUpdateClips, setSelectedClipId } = useVideoEditorStore(nodeId);
  const [cropModalVisible, setCropModalVisible] = useState(false);

  // 获取所有选中的 clips（相同类型的）
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

  // 批量更新所有选中的 clips
  const updateMediaStyle = (updates: Partial<typeof selectedClip.mediaStyle>) => {
    // 使用批量更新，一次性更新所有选中的 clips
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
    // 使用批量更新，一次性更新所有选中的 clips
    const updatedClips = clips.map((clip) => {
      if (selectedClipId.includes(clip.id)) {
        return { ...clip, volume: value };
      }
      return clip;
    });
    batchUpdateClips(updatedClips);
  };

  const updateOpacity = (value: number) => {
    // 使用批量更新，一次性更新所有选中的 clips
    const updatedClips = clips.map((clip) => {
      if (selectedClipId.includes(clip.id)) {
        return { ...clip, opacity: value };
      }
      return clip;
    });
    batchUpdateClips(updatedClips);
  };

  const updateSpeed = (value: number) => {
    // 使用批量更新，一次性更新所有选中的 clips
    const updatedClips = clips.map((clip) => {
      if (selectedClipId.includes(clip.id)) {
        return { ...clip, speed: value };
      }
      return clip;
    });
    batchUpdateClips(updatedClips);
  };

  return (
    <>
      <div className='flex items-center justify-between mb-4'>
        <div className='font-semibold text-xs text-text-default-secondary'>
          {t('toolbar.video') || 'Video'}
        </div>
        <button onClick={() => setSelectedClipId([])} className='text-gray-400 hover:text-gray-600'>
          <Icon name='videoEditor-close-icon' width={12} height={12} />
        </button>
      </div>
      <div className='space-y-4'>
        {/* 裁剪按钮 */}
        <div className='flex items-center py-3 border-b border-border-default-base'>
          <div
            className='p-1.5 rounded outline outline-1 outline-offset-[-1px] outline-border-default-base inline-flex justify-start items-center gap-3 cursor-pointer'
            onClick={() => setCropModalVisible(true)}
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
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) {
                      updateVolume(Math.max(0, Math.min(100, val)));
                    }
                  }}
                  onBlur={(e) => {
                    const val = parseFloat(e.target.value);
                    const finalValue = isNaN(val) ? 100 : Math.max(0, Math.min(100, val));
                    updateVolume(finalValue);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
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
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) {
                      updateOpacity(Math.max(0, Math.min(100, val)));
                    }
                  }}
                  onBlur={(e) => {
                    const val = parseFloat(e.target.value);
                    const finalValue = isNaN(val) ? 100 : Math.max(0, Math.min(100, val));
                    updateOpacity(finalValue);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
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
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) {
                      updateSpeed(Math.max(0.25, Math.min(4, val)));
                    }
                  }}
                  onBlur={(e) => {
                    const val = parseFloat(e.target.value);
                    const finalValue = isNaN(val) ? 1 : Math.max(0.25, Math.min(4, val));
                    updateSpeed(finalValue);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
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
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) {
                      updateMediaStyle({ brightness: Math.max(0, Math.min(200, val)) });
                    }
                  }}
                  onBlur={(e) => {
                    const val = parseFloat(e.target.value);
                    const finalValue = isNaN(val) ? 100 : Math.max(0, Math.min(200, val));
                    updateMediaStyle({ brightness: finalValue });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  className='text-center w-[35px] h-[26px] text-xs p-1 rounded'
                />
                <div className='flex-1 pr-2.5'>
                  <Slider
                    className={sliderClass}
                    value={selectedClip.mediaStyle?.brightness ?? 100}
                    onChange={(value) => updateMediaStyle({ brightness: value })}
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
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) {
                      updateMediaStyle({ blur: Math.max(0, Math.min(100, val)) });
                    }
                  }}
                  onBlur={(e) => {
                    const val = parseFloat(e.target.value);
                    const finalValue = isNaN(val) ? 0 : Math.max(0, Math.min(100, val));
                    updateMediaStyle({ blur: finalValue });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  className='text-center w-[35px] h-[26px] text-xs p-1 rounded'
                />
                <div className='flex-1 pr-2.5'>
                  <Slider
                    className={sliderClass}
                    value={selectedClip.mediaStyle?.blur ?? 0}
                    onChange={(value) => updateMediaStyle({ blur: value })}
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
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) {
                      updateMediaStyle({ borderRadius: Math.max(0, Math.min(100, val)) });
                    }
                  }}
                  onBlur={(e) => {
                    const val = parseFloat(e.target.value);
                    const finalValue = isNaN(val) ? 0 : Math.max(0, Math.min(100, val));
                    updateMediaStyle({ borderRadius: finalValue });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  className='text-center w-[35px] h-[26px] text-xs p-1 rounded'
                />
                <div className='flex-1 pr-2.5'>
                  <Slider
                    className={sliderClass}
                    value={selectedClip.mediaStyle?.borderRadius ?? 0}
                    onChange={(value) => updateMediaStyle({ borderRadius: value })}
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
                  onChange={(color) => updateMediaStyle({ outlineColor: color })}
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
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) {
                    updateMediaStyle({ outlineWidth: Math.max(0, val) });
                  }
                }}
                onBlur={(e) => {
                  const val = parseFloat(e.target.value);
                  const finalValue = isNaN(val) ? 0 : Math.max(0, val);
                  updateMediaStyle({ outlineWidth: finalValue });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
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
                  onChange={(color) => updateMediaStyle({ shadowColor: color })}
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
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) {
                    updateMediaStyle({ shadowOffsetX: val });
                  }
                }}
                onBlur={(e) => {
                  const val = parseFloat(e.target.value);
                  const finalValue = isNaN(val) ? 0 : val;
                  updateMediaStyle({ shadowOffsetX: finalValue });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
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
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) {
                    updateMediaStyle({ shadowOffsetY: val });
                  }
                }}
                onBlur={(e) => {
                  const val = parseFloat(e.target.value);
                  const finalValue = isNaN(val) ? 0 : val;
                  updateMediaStyle({ shadowOffsetY: finalValue });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
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
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) {
                    updateMediaStyle({ shadowBlur: Math.max(0, val) });
                  }
                }}
                onBlur={(e) => {
                  const val = parseFloat(e.target.value);
                  const finalValue = isNaN(val) ? 0 : Math.max(0, val);
                  updateMediaStyle({ shadowBlur: finalValue });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
                className='w-[130px]'
                size='small'
              />
            </div>
          </div>
        </div>
      </div>

      {/* 裁剪模态框 */}
      <CropModal
        visible={cropModalVisible}
        mediaUrl={mediaItem.url || ''}
        mediaType='video'
        mediaThumbnail={mediaItem.thumbnail}
        mediaWidth={mediaItem.width}
        mediaHeight={mediaItem.height}
        existingCrop={selectedClip.cropArea}
        onClose={() => setCropModalVisible(false)}
        onApply={(
          _croppedUrl: string | null,
          cropData: {
            x: number;
            y: number;
            width: number;
            height: number;
            unit: 'px';
          }
        ) => {
          // 视频裁剪：容器尺寸要合理，且宽高比匹配裁剪区域
          const currentWidth = selectedClip.width;
          const currentHeight = selectedClip.height;

          // 计算裁剪区域的宽高比
          const cropRatio = cropData.width / cropData.height;

          let newWidth, newHeight;

          if (currentWidth && currentHeight) {
            // 已有容器：保持面积相近，但调整宽高比为裁剪区域的比例
            const currentArea = currentWidth * currentHeight;
            newHeight = Math.sqrt(currentArea / cropRatio);
            newWidth = newHeight * cropRatio;
          } else {
            // 首次裁剪：模拟 MediaElement 的默认尺寸计算逻辑
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

            // 计算视频未裁剪时的默认显示尺寸
            let originalDisplayWidth: number;
            let originalDisplayHeight: number;
            if (mediaWidth > maxWidth || mediaHeight > maxHeight) {
              // 原始尺寸超过画布50%，需要缩放
              if (mediaRatio > maxWidth / maxHeight) {
                originalDisplayWidth = maxWidth;
                originalDisplayHeight = maxWidth / mediaRatio;
              } else {
                originalDisplayHeight = maxHeight;
                originalDisplayWidth = maxHeight * mediaRatio;
              }
            } else {
              // 原始尺寸小于画布50%，使用原始尺寸
              originalDisplayWidth = mediaWidth;
              originalDisplayHeight = mediaHeight;
            }

            // 计算裁剪比例（裁剪区域占原始视频的比例）
            const cropWidthRatio = cropData.width / mediaWidth;
            const cropHeightRatio = cropData.height / mediaHeight;

            // 裁剪后的容器 = 默认显示尺寸 × 裁剪比例
            newWidth = originalDisplayWidth * cropWidthRatio;
            newHeight = originalDisplayHeight * cropHeightRatio;
          }

          // CSS 裁剪只保存坐标，不保存 croppedUrl（与图片裁剪保持一致）
          updateClip(selectedClip.id, {
            cropArea: cropData,
            width: newWidth,
            height: newHeight,
          });
        }}
      />
    </>
  );
};

export default memo(VideoStylePanel);
