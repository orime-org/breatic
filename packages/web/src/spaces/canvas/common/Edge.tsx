/**
 * Custom edge — Bezier path with an inline delete control on hover
 * + F10 primary-vs-non-primary visual distinction.
 *
 * Visual rules (spec §10.13.2 / §10.13.5 v13):
 *
 *   - **primary** (`data.isPrimary === true`): brand-base stroke,
 *     2.5 px width, marching-ants animation via the
 *     `breatic-edge-primary` className. The animation makes the
 *     primary downstream visually unmistakable when a generative
 *     node has multiple children, since the user needs to know
 *     which branch the next regenerate would overwrite.
 *
 *   - **non-primary**: lighter neutral stroke (`border-default-secondary`),
 *     1.5 px, no animation. Lighter than the v12 default so the
 *     visual hierarchy "primary > regular" is obvious at a glance.
 *
 *   - **selected / hovered**: still wins over the primary state for
 *     the stroke color (matches the rest of the canvas selection
 *     UX), but keeps the primary animation so the user doesn't
 *     lose the "which branch is primary" signal mid-selection.
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
import type { CanvasEdgeData } from '@breatic/shared';
import './Edge.css';

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
  data,
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
  const isPrimary = (data as CanvasEdgeData | undefined)?.isPrimary === true;

  const onEdgeClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteElements({ edges: [{ id }] });
  };

  // Stroke color precedence: selection / hover > primary > default.
  // The user's interaction signal wins so the active edge is always
  // visible, but `breatic-edge-primary` className still applies so
  // the marching-ants animation marks the primary downstream
  // through the highlight color.
  const stroke = active
    ? 'var(--color-border-utilities-selected)'
    : isPrimary
      ? 'var(--color-brand-base)'
      : 'var(--color-border-default-secondary)';

  const edgeStyle: React.CSSProperties = {
    ...style,
    strokeWidth: isPrimary ? 2.5 : 1.5,
    stroke,
  };

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={edgeStyle}
        interactionWidth={20}
        className={isPrimary ? 'breatic-edge-primary' : undefined}
      />
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

// Re-render when geometry, selection, or primary state changes so the
// path / label / animation stay correct. F10 added `data?.isPrimary`
// to the comparator — without it, swapping the primary downstream
// (F3 `setPrimaryDownstreamEdge`) wouldn't repaint the affected edges.
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
  const prevPrimary =
    (prevProps.data as CanvasEdgeData | undefined)?.isPrimary === true;
  const nextPrimary =
    (nextProps.data as CanvasEdgeData | undefined)?.isPrimary === true;
  if (prevPrimary !== nextPrimary) return false;
  return true;
});
