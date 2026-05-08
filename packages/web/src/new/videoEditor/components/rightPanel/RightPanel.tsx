import React, { memo } from 'react';
import { useVideoEditorStore } from '@/app/hooks/useVideoEditorStore';
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

/* * * RightPanel component - right panel * * use ，style consistent */
const RightPanel: React.FC<RightPanelProps> = ({ nodeId, fontConfig = [] }) => {
  const { t } = useTranslation();

  // store get
  const { clips, mediaItems, selectedClipId } = useVideoEditorStore();

  // getallselected clips corresponding media
  const selectedClips = selectedClipId.length > 0
    ? selectedClipId.map((id) => clips.find((c) => c.id === id)).filter(Boolean) as typeof clips
    : [];

  // getallselected clips corresponding media
  const selectedMediaTypes = selectedClips.map((clip) => {
    const media = mediaItems.find((item) => item.id === clip.mediaId);
    if (media?.type) {
      return media.type;
    }
    // ifno media no type，check text（ text ）
    if (clip.text) {
      return 'text';
    }
    return null;
  }).filter((type): type is NonNullable<typeof type> => type !== null);

  // checkallselected same type
  const allSameType = selectedMediaTypes.length > 0 && selectedMediaTypes.every((type) => type === selectedMediaTypes[0]);

  // based on selectedClipId selectedClip（use selected ）
  const selectedClip = selectedClips[0] || null;

  // get selectedasset
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

  // based onasset
  const renderContent = () => {
    // ifnoselected
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

    // ifmulti-select consistent，display
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

    // based onasset corresponding panel
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
      data-right-panel-root='true'
    >
      <div className='p-2.5'>{renderContent()}</div>
    </div>
  );
};

export default memo(RightPanel);
