import React, { memo } from 'react';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
import { MediaItem } from '../../types';
import TextPanel from './TextPanel';
import ImagePanel from './ImagePanel';
import AudioPanel from './AudioPanel';
import VideoPanel from './VideoPanel';
import MediaUploader from './MediaUploader';

interface LeftPanelProps {
  activePanel: string | null;
  nodeId?: string;
  projectId?: string;
  currentTime?: number;
  canvasRatio?: string;
  getBaseCanvasSize?: (ratio: string) => { width: number; height: number };
}

const LeftPanel: React.FC<LeftPanelProps> = ({
  activePanel,
  nodeId,
  projectId,
  currentTime = 0,
  canvasRatio = '16:9',
  getBaseCanvasSize,
}) => {
  const { addMediaItem } = useVideoEditorStore(nodeId);

  const handleMediaAdd = (item: MediaItem) => {
    addMediaItem(item);
  };

  if (!activePanel) {
    return null;
  }

  const getUploadType = (): 'folder' | 'image' | 'audio' | 'video' => {
    switch (activePanel) {
      case 'folder':
        return 'folder';
      case 'images':
        return 'image';
      case 'audio':
        return 'audio';
      case 'videos':
        return 'video';
      default:
        return 'folder';
    }
  };

  return (
    <div
      className='flex flex-col bg-background-default-base nowheel nodrag h-full w-[240px] pointer-events-auto'
      data-nodrag='true'
      data-nopan='true'
      onWheelCapture={(e: React.WheelEvent<HTMLDivElement>) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onWheel={(e: React.WheelEvent<HTMLDivElement>) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <div className='flex-1 overflow-auto'>
        {activePanel !== 'text' && (
          <div className='p-2.5'>
            <MediaUploader onMediaAdd={handleMediaAdd} uploadType={getUploadType()} projectId={projectId} />
          </div>
        )}
        {activePanel === 'folder' && (
          <>
            <TextPanel nodeId={nodeId} currentTime={currentTime} />
            <ImagePanel nodeId={nodeId} currentTime={currentTime} canvasRatio={canvasRatio} getBaseCanvasSize={getBaseCanvasSize} />
            <AudioPanel nodeId={nodeId} currentTime={currentTime} />
            <VideoPanel nodeId={nodeId} currentTime={currentTime} canvasRatio={canvasRatio} getBaseCanvasSize={getBaseCanvasSize} />
          </>
        )}
        {activePanel === 'text' && <TextPanel nodeId={nodeId} currentTime={currentTime} />}
        {activePanel === 'images' && <ImagePanel nodeId={nodeId} currentTime={currentTime} canvasRatio={canvasRatio} getBaseCanvasSize={getBaseCanvasSize} />}
        {activePanel === 'audio' && <AudioPanel nodeId={nodeId} currentTime={currentTime} />}
        {activePanel === 'videos' && <VideoPanel nodeId={nodeId} currentTime={currentTime} canvasRatio={canvasRatio} getBaseCanvasSize={getBaseCanvasSize} />}
      </div>
    </div>
  );
};

export default memo(LeftPanel);
