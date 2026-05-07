/**
 * Custom edge: Bezier path with an inline delete control on the edge.
 */
import React, { useState, memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
  useStore,
  type EdgeProps,
} from '@xyflow/react';
import { Icon } from '@/ui/icon';
import { Button } from '@/ui/button';

const CustomEdge = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  selected,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
}: EdgeProps) => {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const [hovered, setHovered] = useState(false);
  const { deleteElements } = useReactFlow();
  const isSelectionActive = useStore((state) =>
    state.nodes.filter((node) => node.selected).length > 1
  );

  const active = hovered || selected;

  const onEdgeClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteElements({ edges: [{ id }] });
  };

  const edgeStyle = {
    ...style,
    strokeWidth: '2px',
    stroke: active ? 'var(--color-border-utilities-selected)' : 'var(--color-border-default-base)',
  };

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={edgeStyle} interactionWidth={20} />
      <path
        d={edgePath}
        stroke='transparent'
        strokeWidth={20}
        fill='none'
        pointerEvents='stroke'
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <EdgeLabelRenderer>
        <div
          className='button-edge__label nodrag nopan'
          style={{
            position: 'absolute',
            pointerEvents: 'all',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            zIndex: 10,
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {active && !isSelectionActive && (
            <Button
              type='primary'
              size='small'
              shape='circle'
              bordered={false}
              icon={<Icon name='base-close-icon' width={16} height={16} />}
              className='bg-[var(--color-background-error-base)] hover:bg-[var(--color-background-error-base-hover)]'
              onClick={onEdgeClick}
            />
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
};

// Re-render when geometry or selection changes so the path and label stay correct.
export default memo(CustomEdge, (prevProps, nextProps) => {
  if (
    prevProps.sourceX !== nextProps.sourceX ||
    prevProps.sourceY !== nextProps.sourceY ||
    prevProps.targetX !== nextProps.targetX ||
    prevProps.targetY !== nextProps.targetY ||
    prevProps.sourcePosition !== nextProps.sourcePosition ||
    prevProps.targetPosition !== nextProps.targetPosition ||
    prevProps.selected !== nextProps.selected ||
    prevProps.id !== nextProps.id
  ) {
    return false;
  }
  return true;
});
