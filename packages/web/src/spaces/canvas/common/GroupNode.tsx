/**
 * Custom group node
 * Group toolbar is shown by the canvas-layer GroupToolbarPanel (multi-select to group / single-select on group node)
 */
import React, { memo, useRef, useEffect } from 'react';
import type { NodeProps } from '@xyflow/react';
import { NodeResizer } from '@xyflow/react';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';

/* PR9-A: hex literal kept intentionally — `toRgba08` below parses hex digits, so a CSS var token would not work here. */
const defaultGroupBackgroundColor = '#35C838';
const defaultGroupBgRgba = 'rgba(34, 41, 51, 0.8)';

/** Convert hex to rgba(..., 0.8); preserve original alpha if already rgba */
const toRgba08 = (color: string): string => {
  if (!color) return defaultGroupBgRgba;
  if (color === 'transparent') return 'transparent';
  const rgbaMatch = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (rgbaMatch) {
    const alpha = rgbaMatch[4] ?? '0.8';
    return `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${alpha})`;
  }
  const hex = color.replace(/^#/, '');
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return `rgba(${r}, ${g}, ${b}, 0.8)`;
  }
  if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, 0.8)`;
  }
  return color;
};

const GroupNode: React.FC<NodeProps> = ({ id, selected, data }) => {
  const { nodes } = useCanvasData();
  const { updateNode } = useCanvasActions();
  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const rawBg = (data?.backgroundColor as string) || defaultGroupBackgroundColor;
  const backgroundColor = toRgba08(rawBg);
  const locked = (data?.locked as boolean) === true;
  const borderColor = selected ? 'var(--color-border-utilities-selected)' : 'var(--color-border-default-base)';

  const handleResizeEnd = (_: unknown, params: { width: number; height: number }) => {
    const node = nodesRef.current.find((n) => n.id === id);
    const currentStyle = (node?.style ?? {}) as Record<string, unknown>;
    updateNode(id, {
      style: {
        ...currentStyle,
        width: params.width,
        height: params.height,
      },
    });
  };

  return (
    <>
      <div className='absolute inset-0 rounded-[6px] pointer-events-none' style={{ backgroundColor }} aria-hidden />
      {!locked && (
        <NodeResizer
          color={borderColor}
          isVisible={true}
          minWidth={60}
          minHeight={60}
          handleStyle={{ display: 'none' }}
          lineClassName='rounded-[6px]'
          lineStyle={{
            border: '2px solid',
            borderColor,
            borderRadius: 6,
          }}
          onResizeEnd={handleResizeEnd}
        />
      )}
    </>
  );
};

export default memo(GroupNode);
