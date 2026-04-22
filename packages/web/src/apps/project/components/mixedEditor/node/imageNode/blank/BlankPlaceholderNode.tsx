import React, { memo, useCallback } from 'react';
import { NodeToolbar as FlowNodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { useMixedEditorStore } from '@/hooks/useMixedEditorStore';
import { createEditorImageNodeData, imageEditorImageNodeType } from '../../../types';
import BlankBottomToolbar from './BlankBottomToolbar';
import { BlankPlaceholderPanel, blankPlaceholderDefaultHeight, blankPlaceholderDefaultWidth } from './BlankPlaceholderPanel';

/**
 * Renders a solid white PNG at the given pixel size.
 *
 * @param width - Width in CSS pixels
 * @param height - Height in CSS pixels
 * @returns Data URL or null if canvas is unavailable
 */
const whiteCanvasToDataUrl = (width: number, height: number): string | null => {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  return canvas.toDataURL('image/png');
};

/**
 * White placeholder on the flow: resizable until confirmed, then becomes a normal image node.
 */
const BlankPlaceholderNode: React.FC<NodeProps> = ({ id, selected, width, height }) => {
  const { updateNode } = useMixedEditorStore();
  const nodeWidth = Math.max(1, Math.round(width ?? blankPlaceholderDefaultWidth));
  const nodeHeight = Math.max(1, Math.round(height ?? blankPlaceholderDefaultHeight));

  const handleSave = useCallback(
    (next: { width: number; height: number }) => {
      const w = Math.max(1, Math.round(next.width));
      const h = Math.max(1, Math.round(next.height));
      const src = whiteCanvasToDataUrl(w, h);
      if (!src) return;
      updateNode(id, {
        type: imageEditorImageNodeType,
        selected: true,
        style: { width: w, height: h },
        data: createEditorImageNodeData('Blank', src),
      });
    },
    [id, updateNode],
  );

  return (
    <>
      <FlowNodeToolbar isVisible={Boolean(selected)} position={Position.Bottom} offset={10} align='center'>
        <BlankBottomToolbar
          active={Boolean(selected)}
          width={nodeWidth}
          height={nodeHeight}
          onSave={handleSave}
        />
      </FlowNodeToolbar>
      <BlankPlaceholderPanel selected={Boolean(selected)} />
    </>
  );
};

export default memo(BlankPlaceholderNode);
