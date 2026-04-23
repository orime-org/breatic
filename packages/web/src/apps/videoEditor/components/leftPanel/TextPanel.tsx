import React, { memo } from 'react';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
import { useTranslation } from 'react-i18next';
import { MediaItem, TimelineClip } from '../../types';
import { Button } from '@/components/base/button';

interface TextPanelProps {
  nodeId?: string;
  currentTime?: number;
}

/**
 * TextPanel 组件 - 文字面板
 */
const TextPanel: React.FC<TextPanelProps> = ({ currentTime = 0 }) => {
  const { t } = useTranslation();
  const { mediaItems, addClip, addMediaItem } = useVideoEditorStore();

  const textItems = mediaItems.filter((item: MediaItem) => item.type === 'text');

  // 计算文字宽度
  const calculateTextWidth = (text: string, fontSize: number): number => {
    // 创建一个临时的 DOM 元素来测量宽度
    const tempSpan = document.createElement('span');
    tempSpan.style.position = 'absolute';
    tempSpan.style.visibility = 'hidden';
    tempSpan.style.fontSize = `${fontSize}px`;
    tempSpan.style.fontFamily = 'Arial';
    tempSpan.style.whiteSpace = 'nowrap';
    tempSpan.textContent = text || 'Text';

    document.body.appendChild(tempSpan);
    const width = tempSpan.offsetWidth;
    document.body.removeChild(tempSpan);

    // 设置最小和最大宽度
    const minWidth = fontSize * 2; // 最小宽度为字体大小的2倍
    const maxWidth = 1920 * 0.8; // 最大宽度为画布宽度的80%
    return Math.max(minWidth, Math.min(width + 40, maxWidth)); // 添加40px的padding
  };

  // 计算文字高度
  const calculateTextHeight = (text: string, width: number, fontSize: number): number => {
    // 创建一个临时的 DOM 元素来测量高度
    const tempDiv = document.createElement('div');
    tempDiv.style.position = 'absolute';
    tempDiv.style.visibility = 'hidden';
    tempDiv.style.width = `${width}px`;
    tempDiv.style.height = 'auto';
    tempDiv.style.fontSize = `${fontSize}px`;
    tempDiv.style.fontFamily = 'Arial';
    tempDiv.style.lineHeight = '1.6';
    tempDiv.style.overflowWrap = 'break-word';
    tempDiv.style.wordBreak = 'break-word';
    tempDiv.style.whiteSpace = 'pre-wrap';
    tempDiv.textContent = text || 'Text';

    document.body.appendChild(tempDiv);
    const height = tempDiv.offsetHeight;
    document.body.removeChild(tempDiv);

    const minHeight = Math.max(fontSize * 1.5, 60);
    return Math.max(height, minHeight);
  };

  const handleTextAdd = (text: string) => {
    let existingTextMedia = mediaItems.find((item: MediaItem) => item.type === 'text');

    // 如果没有找到 text mediaItem，创建一个新的
    if (!existingTextMedia) {
      const newTextMedia: MediaItem = {
        id: `text-media-${Date.now()}`,
        type: 'text',
        name: 'Text',
        text: text,
        url: '',
      };
      addMediaItem(newTextMedia);
      existingTextMedia = newTextMedia;
    }

    const textMediaId = existingTextMedia.id;

    const canvasWidth = 1920;
    const canvasHeight = 1080;
    const fontSize = 48;

    // 计算文字宽度（自适应）
    const calculatedWidth = calculateTextWidth(text, fontSize);
    // 计算文字高度
    const calculatedHeight = calculateTextHeight(text, calculatedWidth, fontSize);

    const clip: TimelineClip = {
      id: `clip-${Date.now()}-${Math.random()}`,
      mediaId: textMediaId,
      type: 'text',
      start: currentTime,
      end: currentTime + 5,
      trackIndex: 0,
      text: text,
      width: calculatedWidth,
      height: calculatedHeight,
      x: (canvasWidth - calculatedWidth) / 2,
      y: (canvasHeight - calculatedHeight) / 2,
      textStyle: {
        fontSize: fontSize,
        fontFamily: 'Arial',
        color: '#FFFFFF',
        textAlign: 'center',
      },
    };

    // 使用 addClip，会自动选中新添加的素材
    addClip(clip);
  };

  const handleTextClick = (item: MediaItem) => {
    handleTextAdd(item.text || 'Text');
  };

  return (
    <div className='flex flex-col'>
      <div className='p-2.5 pt-2.5 pb-0'>
        <div className='mb-2.5 text-xs font-semibold text-text-default-secondary'>{t('toolbar.text')}</div>
        <Button block onClick={() => handleTextAdd('Text')}>
          {t('mediaLibrary.addText')}
        </Button>
      </div>
      {textItems.length > 0 && (
        <div className='px-2.5 pt-2.5 pb-2.5'>
          <div className='flex flex-col gap-2.5'>
            {textItems.map((item: MediaItem) => (
              <div
                key={item.id}
                className='relative overflow-hidden border border-border-default-base cursor-pointer group hover:border-blue-400 rounded h-[30px]'
                onClick={() => handleTextClick(item)}
              >
                <div className='flex items-center justify-center w-full h-full'>
                  <div className='text-left text-text-default-tertiary truncate text-xs p-2.5'>
                    {item.text}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default memo(TextPanel);

