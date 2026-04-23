import React, { useState, memo } from 'react';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
import { useTranslation } from 'react-i18next';
import Tooltip from '@/components/base/tooltip';
import { Icon } from '@/components/base/icon';
import { MediaItem, TimelineClip } from '../../types';

interface ImagePanelProps {
  nodeId?: string;
  currentTime?: number;
  canvasRatio?: string;
  getBaseCanvasSize?: (ratio: string) => { width: number; height: number };
}

/**
 * ImagePanel 组件 - 图片面板
 */
const ImagePanel: React.FC<ImagePanelProps> = ({ currentTime = 0, canvasRatio = '16:9', getBaseCanvasSize }) => {
  const { t } = useTranslation();
  const [loadingStates, setLoadingStates] = useState<Record<string, boolean>>({});
  const { mediaItems, addClip } = useVideoEditorStore();

  const imageItems = mediaItems.filter((item: MediaItem) => item.type === 'image');

  const handleMediaClick = (item: MediaItem) => {
    const clip: TimelineClip = {
      id: `clip-${Date.now()}-${Math.random()}`,
      mediaId: item.id,
      type: 'image',
      start: currentTime,
      end: currentTime + 5,
      trackIndex: 0,
    };
    if (item.width && item.height && getBaseCanvasSize) {
      const baseCanvasSize = getBaseCanvasSize(canvasRatio);
      const CANVAS_WIDTH = baseCanvasSize.width;
      const CANVAS_HEIGHT = baseCanvasSize.height;
      const mediaRatio = item.width / item.height;
      const canvasRatioValue = CANVAS_WIDTH / CANVAS_HEIGHT;

      // 填充满画布，保持宽高比不变形
      // 如果媒体更宽（宽高比更大），则宽度填充满画布，高度按比例缩放
      // 如果媒体更高（宽高比更小），则高度填充满画布，宽度按比例缩放
      if (mediaRatio > canvasRatioValue) {
        // 媒体更宽，宽度填充满画布
        clip.width = CANVAS_WIDTH;
        clip.height = CANVAS_WIDTH / mediaRatio;
      } else {
        // 媒体更高，高度填充满画布
        clip.height = CANVAS_HEIGHT;
        clip.width = CANVAS_HEIGHT * mediaRatio;
      }
      clip.x = (CANVAS_WIDTH - clip.width) / 2;
      clip.y = (CANVAS_HEIGHT - clip.height) / 2;
    }

    // 使用 addClip，会自动选中新添加的素材
    addClip(clip);
  };

  if (imageItems.length === 0) {
    return null;
  }

  return (
    <div className='flex flex-col'>
      <div className='p-2.5'>
        <div className='mb-2.5 text-xs font-semibold text-text-default-secondary'>{t('toolbar.image')}</div>
      </div>
      <div className='px-2.5 pb-2.5'>
        <div className='flex flex-col gap-2.5'>
          {imageItems.map((item: MediaItem) => {
            const isLoading = loadingStates[item.id] !== false;
            return (
              <div
                key={item.id}
                className='relative overflow-hidden border border-border-default-base cursor-pointer group hover:border-blue-400 rounded'
                onClick={() => handleMediaClick(item)}
              >
                <div className='relative bg-gray-100 aspect-video min-h-[100px]'>
                  {isLoading && (
                    <div className='absolute inset-0 flex items-center justify-center bg-[#E5E5E5] z-10'>
                      <Icon name='videoEditor-loading-spinner' width={32} height={32} className='animate-spin' />
                    </div>
                  )}
                  <img
                    src={item.thumbnail ?? item.url}
                    alt={item.name}
                    className='object-contain w-full h-full aspect-video object-center bg-white'
                    onLoad={() => setLoadingStates((prev) => ({ ...prev, [item.id]: false }))}
                    onError={() => setLoadingStates((prev) => ({ ...prev, [item.id]: false }))}
                  />
                </div>
                <div className='px-2.5 py-1.5 min-w-0'>
                  <Tooltip title={item.name || ''} asChild={false} triggerClassName='block w-full min-w-0'>
                    <div className='w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-text-default-tertiary'>
                      {item.name || ''}
                    </div>
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default memo(ImagePanel);

