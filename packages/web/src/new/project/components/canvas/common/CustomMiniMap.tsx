import React from 'react';
import { MiniMap, useReactFlow, type Node as ReactFlowNode } from '@xyflow/react';

const handleTypeColorMap: Record<string, string> = {
  Text: 'var(--color-node-handle-text-node)',
  Image: 'var(--color-node-handle-image-node)',
  Video: 'var(--color-node-handle-video-node)',
  Audio: 'var(--color-node-handle-audio-node)',
};

const getNodeColor = (node: ReactFlowNode): string => {
  const nodeData = node.data as { handles?: { target?: Array<{ handleType: string }> } };
  const targetHandles = nodeData?.handles?.target;
  if (targetHandles && targetHandles.length > 0) {
    const firstSourceHandleType = targetHandles[0]?.handleType;
    if (firstSourceHandleType) {
      return handleTypeColorMap[firstSourceHandleType] ?? '#95CBEB';
    }
  }
  return '#95CBEB';
};

interface CustomMiniMapProps {
  style?: React.CSSProperties;
  backgroundColor?: string;
  maskColor?: string;
  maskStrokeColor?: string;
}

const CustomMiniMap: React.FC<CustomMiniMapProps> = ({
  style,
  backgroundColor = 'var(--color-background-default-base)',
  maskColor = 'var(--color-shadow-scrim)',
  maskStrokeColor = 'var(--color-background-success-secondary)',
}) => {
  const { fitView } = useReactFlow();

  const handleMiniMapNodeClick = (_event: React.MouseEvent, node: ReactFlowNode) => {
    fitView({
      nodes: [node],
      duration: 800,
      padding: 0.2,
    });
  };

  const defaultStyle: React.CSSProperties = {
    left: 0,
    bottom: 50,
    width: 238,
    height: 139,
    borderRadius: '8px',
    overflow: 'hidden',
    backgroundColor,
    boxShadow:
      '0px 4px 16px -1px rgba(255, 255, 255, 0.05), 0px 4px 4px -1px rgba(255, 255, 255, 0.05), 0px 1px 8px 1px rgba(255, 255, 255, 0.05)',
  };

  return (
    <MiniMap
      nodeColor={getNodeColor}
      onNodeClick={handleMiniMapNodeClick}
      maskColor={maskColor}
      maskStrokeColor={maskStrokeColor}
      style={{
        ...defaultStyle,
        ...style,
      }}
    />
  );
};

export default CustomMiniMap;
