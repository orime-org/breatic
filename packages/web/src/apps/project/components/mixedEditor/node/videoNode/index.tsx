import React, { memo } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import Loading from '@/components/loading';
import Video from '@/apps/project/components/canvas/common/Video';
import { useImageEditorStore } from '@/hooks/useImageEditorStore';
import NodeHeader from '../../common/NodeHeader';
import type { ImageFlowNodeData } from '../../types';

const videoFlowMinWidth = 120;
const videoFlowMinHeight = 80;

const VideoNode: React.FC<NodeProps> = ({ id, data, selected, width, height }) => {
  const { updateNodeData } = useImageEditorStore();
  const nodeData = data as ImageFlowNodeData | undefined;
  const videoContent = String(nodeData?.content ?? '');
  const title = nodeData?.name?.trim() || 'video';
  const currentWidth = Math.max(1, Math.round(width ?? videoFlowMinWidth));
  const currentHeight = Math.max(1, Math.round(height ?? videoFlowMinHeight));
  const resolutionText = `${currentWidth}x${currentHeight}`;

  return (
    <div
      className='relative h-full w-full min-w-0'
      style={{ minWidth: videoFlowMinWidth, minHeight: videoFlowMinHeight }}
    >
      <div className='absolute -translate-y-full left-0 right-0 -top-0 overflow-hidden'>
        <NodeHeader
          title={title}
          resolutionText={resolutionText}
          editable
          onTitleChange={(value) => updateNodeData(id, { name: value })}
        />
      </div>
      <NodeResizer
        isVisible={selected}
        keepAspectRatio
        minWidth={videoFlowMinWidth}
        minHeight={videoFlowMinHeight}
      />
      <div
        className='relative flex h-full min-h-0 flex-col bg-background-default-base outline outline-2 pointer-events-auto'
        style={{ outlineColor: selected ? 'var(--color-border-utilities-selected)' : 'transparent' }}
      >
        <div className='relative h-full w-full min-h-0 overflow-hidden bg-white shadow-sm'>
          {videoContent ? (
            <Video src={videoContent} showControlBar={selected} className='h-full w-full !rounded-none' />
          ) : (
            <Loading inline width='100%' height='100%' text='Loading Video...' />
          )}
        </div>
      </div>
    </div>
  );
};

export default memo(VideoNode);
