/**
 * Group container node for the local-only canvas (no Yjs).
 * Mirrors {@link ../../../../apps/project/components/canvas/common/GroupNode.tsx}.
 */
import { memo, useCallback, type FC } from 'react';
import type { NodeProps } from '@xyflow/react';
import { NodeResizer, useReactFlow } from '@xyflow/react';

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

const LocalGroupNode: FC<NodeProps> = ({ id, selected, data }) => {
  const { setNodes } = useReactFlow();

  const rawBg = (data?.backgroundColor as string) || defaultGroupBackgroundColor;
  const backgroundColor = toRgba08(rawBg);
  const locked = (data?.locked as boolean) === true;
  const borderColor = selected ? 'var(--color-border-utilities-selected)' : 'var(--color-border-default-base)';

  const handleResizeEnd = useCallback(
    (_: unknown, params: { width: number; height: number }) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          const currentStyle = (n.style ?? {}) as Record<string, unknown>;
          return {
            ...n,
            style: {
              ...currentStyle,
              width: params.width,
              height: params.height,
            },
          };
        }),
      );
    },
    [id, setNodes],
  );

  return (
    <>
      {/*
        Hit target for context menu / drag on empty group padding.
        `pointer-events-none` lets clicks fall through to the pane so node `onNodeContextMenu` never fires — align with GroupNode interaction expectations (see apps/project canvas).
      */}
      <div className='pointer-events-auto absolute inset-0 rounded-[6px]' style={{ backgroundColor }} aria-hidden />
      {!locked && (
        <NodeResizer
          color={borderColor}
          isVisible
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

export default memo(LocalGroupNode);
