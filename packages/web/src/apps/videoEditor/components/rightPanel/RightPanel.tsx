import React, { memo } from 'react';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
import { useTranslation } from 'react-i18next';
import { MediaItem } from '../../types';
import TextStylePanel from './TextStylePanel';
import VideoStylePanel from './VideoStylePanel';
import ImageStylePanel from './ImageStylePanel';
import AudioStylePanel from './AudioStylePanel';

interface RightPanelProps {
  nodeId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fontConfig?: any[];
}

/**
 * RightPanel 组件 - 右侧属性面板
 *
 * 使用静态数据，样式和原来完全一致
 */
const RightPanel: React.FC<RightPanelProps> = ({ nodeId, fontConfig = [] }) => {
  const { t } = useTranslation();

  // 从 store 获取数据
  const { clips, mediaItems, selectedClipId } = useVideoEditorStore(nodeId);

  // 获取所有选中的 clips 和对应的 media 类型
  const selectedClips = selectedClipId.length > 0
    ? selectedClipId.map((id) => clips.find((c) => c.id === id)).filter(Boolean) as typeof clips
    : [];

  // 获取所有选中 clips 对应的 media 类型
  const selectedMediaTypes = selectedClips.map((clip) => {
    const media = mediaItems.find((item) => item.id === clip.mediaId);
    if (media?.type) {
      return media.type;
    }
    // 如果没有找到 media 或没有 type，检查是否是文字（通过 text 属性判断）
    if (clip.text) {
      return 'text';
    }
    return null;
  }).filter((type): type is NonNullable<typeof type> => type !== null);

  // 检查所有选中的元素是否都是相同类型
  const allSameType = selectedMediaTypes.length > 0 && selectedMediaTypes.every((type) => type === selectedMediaTypes[0]);

  // 根据 selectedClipId 找到 selectedClip（使用第一个选中的）
  const selectedClip = selectedClips[0] || null;

  // 获取当前选中素材的媒体信息
  const selectedMedia = ((): MediaItem | null => {
    if (!selectedClip) return null;
    let media = mediaItems.find((item) => item.id === selectedClip.mediaId) || null;
    if (!media || !media.type) {
      media = {
        id: selectedClip.mediaId || '',
        name: selectedClip.mediaId || '',
        text: selectedClip.text || 'Text',
        type: 'text',
        url: '',
      };
    }
    return media;
  })();

  // 根据素材类型渲染不同的内容
  const renderContent = () => {
    // 如果没有选中任何元素
    if (selectedClips.length === 0) {
      return (
        <div className='py-8 text-center text-gray-400'>
          <p className='text-xs'>{t('rightPanel.selectElement')}</p>
          <p className='mt-2 text-xs'>
            {t('rightPanel.selectToEdit')}
          </p>
        </div>
      );
    }

    // 如果多选但类型不一致，显示提示
    if (selectedClips.length > 1 && !allSameType) {
      return (
        <div className='py-8 text-center text-gray-400'>
          <p className='text-xs'>{t('rightPanel.mixedSelection') || '已选择多个不同类型的元素'}</p>
          <p className='mt-2 text-xs'>
            {t('rightPanel.selectSameType') || '请选择相同类型的元素以编辑属性'}
          </p>
        </div>
      );
    }

    if (!selectedClip || !selectedMedia) {
      return (
        <div className='py-8 text-center text-gray-400'>
          <p className='text-xs'>{t('rightPanel.selectElement')}</p>
          <p className='mt-2 text-xs'>
            {t('rightPanel.selectToEdit')}
          </p>
        </div>
      );
    }

    // 根据素材类型渲染对应的面板
    const mediaType = selectedMedia.type;

    switch (mediaType) {
      case 'text':
        return <TextStylePanel nodeId={nodeId} fontConfig={fontConfig} />;
      case 'video':
        return <VideoStylePanel nodeId={nodeId} />;
      case 'image':
        return <ImageStylePanel nodeId={nodeId} />;
      case 'audio':
        return <AudioStylePanel nodeId={nodeId} />;
      default:
        return (
          <div className='py-8 text-center text-gray-400'>
            <p className='text-xs'>{t('rightPanel.unknownMediaType') || 'Unknown media type'}</p>
          </div>
        );
    }
  };

  return (
    <div
      className='overflow-y-auto bg-background-default-base border-l border-border-default-base nopan nodrag nowheel w-[240px] pointer-events-auto'
      data-nopan='true'
      data-nodrag='true'
      data-nowheel='true'
    >
      <div className='p-2.5'>{renderContent()}</div>
    </div>
  );
};

export default memo(RightPanel);
