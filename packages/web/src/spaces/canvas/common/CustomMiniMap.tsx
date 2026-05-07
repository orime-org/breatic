import React from 'react';
import { MiniMap, useReactFlow, type Node as ReactFlowNode } from '@xyflow/react';
/** Handle type color map (kept in sync with BlockMeta in Handle.tsx). */

const handleTypeColorMap: Record<string, string> = {
  Text: 'var(--color-node-handle-text-node)',
  Image: 'var(--color-node-handle-image-node)',
  Video: 'var(--color-node-handle-video-node)',
  Audio: 'var(--color-node-handle-audio-node)',
};

/** Resolve node color from its output handle type. */
const getNodeColor = (node: ReactFlowNode): string => {
  // Read target handles (output handles) from node data.
  const nodeData = node.data as { handles?: { target?: Array<{ handleType: string }> } };
  const targetHandles = nodeData?.handles?.target;
  if (targetHandles && targetHandles.length > 0) {
    // Use the first output handle type.
    const firstSourceHandleType = targetHandles[0]?.handleType;
    if (firstSourceHandleType) {
      // Resolve color from type map.
      return handleTypeColorMap[firstSourceHandleType];
    }
  }
  // Fallback color when no output handles exist.
  return '#95CBEB';
};

/** CustomMiniMap props. */
interface CustomMiniMapProps {
  /** Custom style merged over defaults. */
  style?: React.CSSProperties;
  /** Background color. */
  backgroundColor?: string;
  /** Viewport mask background color. */
  maskColor?: string;
  /** Viewport mask border color. */
  maskStrokeColor?: string;
}

/** Custom minimap with handle-type node colors and click-to-focus behavior. */

const CustomMiniMap: React.FC<CustomMiniMapProps> = ({
  style,
  backgroundColor = 'var(--color-background-default-base)',
  maskColor = 'var(--color-shadow-scrim)',
  maskStrokeColor = 'var(--color-background-success-secondary)',
}) => {
  const { fitView } = useReactFlow();

  // Focus clicked node in the viewport.
  const handleMiniMapNodeClick = (_event: React.MouseEvent, node: ReactFlowNode) => {
    fitView({
      nodes: [node],
      duration: 800,
      padding: 0.2,
    });
  };

  // Default style: fixed at left, above undo/redo toolbar.
  const defaultStyle: React.CSSProperties = {
    left: 0,
    bottom: 50,
    width: 238,
    height: 139,
    borderRadius: '8px',
    overflow: 'hidden',
    backgroundColor,
    boxShadow: '0px 4px 16px -1px rgba(255, 255, 255, 0.05), 0px 4px 4px -1px rgba(255, 255, 255, 0.05), 0px 1px 8px 1px rgba(255, 255, 255, 0.05)',
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

