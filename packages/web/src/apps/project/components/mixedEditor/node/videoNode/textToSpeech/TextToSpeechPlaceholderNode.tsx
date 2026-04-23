import React, { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import {
  TextToSpeechPlaceholderPanel,
  type VideoQuickActionPlacementType,
} from './TextToSpeechPlaceholderPanel';

type TextToSpeechPlaceholderNodeData = {
  action?: VideoQuickActionPlacementType;
};

/**
 * React Flow node shell for the video quick-action placeholder (Text-to-Speech or stabilization hint).
 * Reads `data.action`, passes `selected` into the panel for the same border treatment as `BlankPlaceholderPanel`.
 * Width/height come from the node `style` set when the item is placed; the panel fills the box with `h-full w-full`.
 */
const TextToSpeechPlaceholderNode: React.FC<NodeProps> = ({ data, selected }) => {
  const nodeData = (data ?? {}) as TextToSpeechPlaceholderNodeData;
  const action = nodeData.action ?? 'audioDenoise';
  return <TextToSpeechPlaceholderPanel action={action} selected={Boolean(selected)} />;
};

export default memo(TextToSpeechPlaceholderNode);
