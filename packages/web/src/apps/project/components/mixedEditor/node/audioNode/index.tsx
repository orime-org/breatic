import React, { memo } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import Loading from '@/components/loading';
import AudioNodePlayer from '@/apps/project/components/canvas/dataNode/audioNode/AudioNodePlayer';
import { useMixedEditorStore } from '@/hooks/useMixedEditorStore';
import NodeHeader from '../../common/NodeHeader';
import type { ImageFlowNodeData } from '../../types';

const audioFlowDefaultWidth = 300;
const audioFlowDefaultHeight = 250;
const audioFlowMinWidth = 180;
const audioFlowMinHeight = 140;

const AudioNode: React.FC<NodeProps> = ({ id, data, selected, width, height }) => {
  const { updateNodeData } = useMixedEditorStore();
  const nodeData = data as ImageFlowNodeData | undefined;
  const audioContent = String(nodeData?.content ?? '');
  const title = nodeData?.name?.trim() || 'audio';
  const currentWidth = Math.max(1, Math.round(width ?? audioFlowDefaultWidth));
  const currentHeight = Math.max(1, Math.round(height ?? audioFlowDefaultHeight));
  const resolutionText = `${currentWidth}x${currentHeight}`;

  return (
    <div
      className='relative h-full w-full min-w-0'
      style={{ minWidth: audioFlowMinWidth, minHeight: audioFlowMinHeight }}
    >
      <div className='absolute -translate-y-full left-0 right-0 -top-0 overflow-hidden'>
        <NodeHeader title={title} resolutionText={resolutionText} editable onTitleChange={(value) => updateNodeData(id, { name: value })} />
      </div>
      <NodeResizer
        isVisible={selected}
        keepAspectRatio
        minWidth={audioFlowMinWidth}
        minHeight={audioFlowMinHeight}
      />
      <div
        className='relative flex h-full min-h-0 flex-col bg-background-default-base outline outline-2 pointer-events-auto'
        style={{ outlineColor: selected ? 'var(--color-border-utilities-selected)' : 'transparent' }}
      >
        <div className='relative h-full w-full min-h-0 overflow-hidden bg-white shadow-sm'>
          {audioContent ? (
            <div className='w-full h-full'>
              <AudioNodePlayer src={audioContent} selected={selected} showQuickActions={false} />
            </div>
          ) : (
            <Loading inline width='100%' height='100%' text='Loading Audio...' />
          )}
        </div>
      </div>
    </div>
  );
};

export default memo(AudioNode);
