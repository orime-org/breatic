/**
 * Port of {@link DataNodeHandle} for the local canvas — same visuals and connection UX
 * (large hit area, drag-to-connect `onPointerUp`, plus-menu new node), using `useReactFlow`
 * instead of Yjs / `useCanvasActions`.
 */
import React, { useState, useRef, useEffect } from 'react';
import { Handle, Position, useConnection, useReactFlow, addEdge, type Connection } from '@xyflow/react';
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
  useDismiss,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import { Icon } from '@/components/base/icon';
import { spawnLocalFlowPaletteNodeConnected } from './localFlowNodeSpawn';
import AgentNodesMenuRows from './AgentNodesMenuRows';

const containerSize = 48;
const iconSize = 24;

export interface LocalDataNodeHandleProps {
  type: 'target' | 'source';
  position: Position.Left | Position.Right;
  handleId: string;
  nodeId: string;
  selected: boolean;
  nodeHovered: boolean;
  isInsideLockedGroup?: boolean;
  /**
   * When true, hides plus affordance (e.g. multi-select uses a single outbound handle on the selection bounds).
   */
  hideChrome?: boolean;
  /**
   * When true with {@link hideChrome}, keeps an invisible hit area and React Flow connectability
   * (multi-select: all inbound targets stay connectable; only one outbound source — the representative — should set this on `source`).
   */
  keepConnectableWhenHidden?: boolean;
  /**
   * When false, disables drag-to-connect and the quick “+” node menu on this handle
   * (edges may still be added programmatically, e.g. generator send → output).
   */
  allowManualConnect?: boolean;
}

const LocalDataNodeHandle: React.FC<LocalDataNodeHandleProps> = ({
  type,
  position,
  handleId,
  nodeId,
  selected,
  nodeHovered,
  isInsideLockedGroup = false,
  hideChrome = false,
  keepConnectableWhenHidden = false,
  allowManualConnect = true,
}) => {
  const { getNodes, setNodes, setEdges, screenToFlowPosition } = useReactFlow();
  const connection = useConnection();
  const containerRef = useRef<HTMLDivElement>(null);
  const [handleHovered, setHandleHovered] = useState(false);
  const [iconOffset, setIconOffset] = useState({ x: 0, y: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const [clickPosition, setClickPosition] = useState<{ x: number; y: number } | null>(null);

  const virtualRef = useRef({
    getBoundingClientRect: (): DOMRect => new DOMRect(0, 0, 0, 0),
  });

  const { refs, floatingStyles, context } = useFloating({
    open: menuOpen,
    onOpenChange: setMenuOpen,
    placement: 'top-start',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  const dismiss = useDismiss(context, { outsidePress: true });
  const { getFloatingProps } = useInteractions([dismiss]);

  useEffect(() => {
    if (menuOpen && clickPosition) {
      virtualRef.current.getBoundingClientRect = () => new DOMRect(clickPosition.x, clickPosition.y, 0, 0);
      refs.setReference(virtualRef.current);
    }
  }, [menuOpen, clickPosition, refs]);

  const applyConnect = (connectionParams: Connection) => {
    const edgeId = `e-${connectionParams.source}-${connectionParams.sourceHandle ?? ''}-${connectionParams.target}-${connectionParams.targetHandle ?? ''}`;
    setEdges((eds) => {
      if (eds.some((e) => e.id === edgeId)) return eds;
      return addEdge({ ...connectionParams, id: edgeId, type: 'default' }, eds);
    });
  };

  const showVisualChrome = !isInsideLockedGroup && !hideChrome;
  /** No interaction chrome when manual connect is disabled (e.g. generator output — edges only via code). */
  const showHitArea =
    allowManualConnect && !isInsideLockedGroup && (showVisualChrome || keepConnectableWhenHidden);
  const canConnect = allowManualConnect && !isInsideLockedGroup && showHitArea;
  const showIcon = allowManualConnect && showVisualChrome && (selected || nodeHovered || handleHovered);

  const clampIconCenter = (rect: DOMRect, clientX: number, clientY: number) => {
    const mouseX = (rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5) * containerSize;
    const mouseY = (rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5) * containerSize;
    const centerX = Math.max(iconSize / 2, Math.min(containerSize - iconSize / 2, mouseX));
    const centerY = Math.max(iconSize / 2, Math.min(containerSize - iconSize / 2, mouseY));
    return { x: centerX - containerSize / 2, y: centerY - containerSize / 2 };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    setIconOffset(clampIconCenter(rect, e.clientX, e.clientY));
  };

  const handleMouseLeave = () => {
    setHandleHovered(false);
    setIconOffset({ x: 0, y: 0 });
  };

  const handlePlusClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!showVisualChrome) return;
    if (!allowManualConnect || isInsideLockedGroup || connection?.inProgress) return;
    setClickPosition({ x: e.clientX, y: e.clientY });
    setMenuOpen(true);
  };

  const handleAddNode = (nodeType: string) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const isConnectFromLeft = position === Position.Left;
    spawnLocalFlowPaletteNodeConnected({
      existingNodeId: nodeId,
      existingHandleId: handleId,
      screenCenter: { x: centerX, y: centerY },
      newPaletteNodeType: nodeType,
      isConnectFromLeft,
      existingEdgeRole: type === 'target' ? 'existingIsTarget' : 'existingIsSource',
      getNodes,
      setNodes,
      setEdges,
      screenToFlowPosition,
    });
    setMenuOpen(false);
  };

  const handlePointerUp = () => {
    if (!allowManualConnect) return;
    if (!connection?.inProgress || !connection.fromNode || !connection.fromHandle) return;
    const fromId = connection.fromNode.id;
    const fromHandleId =
      typeof connection.fromHandle === 'object' && connection.fromHandle !== null && 'id' in connection.fromHandle
        ? String((connection.fromHandle as { id: string }).id)
        : null;
    if (!fromId || !fromHandleId || fromId === nodeId) return;

    if (type === 'target') {
      applyConnect({
        source: fromId,
        sourceHandle: fromHandleId,
        target: nodeId,
        targetHandle: handleId,
      });
    } else {
      applyConnect({
        source: nodeId,
        sourceHandle: handleId,
        target: fromId,
        targetHandle: fromHandleId,
      });
    }
  };

  const isLeft = position === Position.Left;
  const positionClass = isLeft ? 'left-0 -translate-x-full' : 'right-0 translate-x-full';

  return (
    <>
      <Handle
        type={type}
        position={position}
        id={handleId}
        className='nodrag nopan !border-none !bg-transparent'
        isConnectableStart={canConnect && type === 'source'}
        isConnectableEnd={canConnect && type === 'target'}
      >
        <div
          ref={containerRef}
          data-connect-handle-area
          className={`nodrag nopan absolute top-1/2 flex -translate-y-1/2 items-center justify-center transition-opacity duration-150 ${positionClass} ${
            showHitArea
              ? 'h-[48px] w-[48px] opacity-100'
              : 'pointer-events-none h-0 min-h-0 w-0 min-w-0 overflow-hidden opacity-0'
          }`}
          onMouseEnter={() => setHandleHovered(true)}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onPointerUp={handlePointerUp}
          onClick={handlePlusClick}
        >
          <div
            className={
              'pointer-events-none flex h-[24px] w-[24px] items-center justify-center rounded-full bg-background-default-base shadow-sm transition-opacity duration-150 ' +
              (showIcon ? 'opacity-100' : 'opacity-0')
            }
            style={{ transform: `translate(${iconOffset.x}px, ${iconOffset.y}px)` }}
          >
            <Icon name='project-plus-icon' width={14} height={14} color='var(--color-text-default-base)' />
          </div>
        </div>
      </Handle>
      {menuOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className='z-[1000] min-w-[260px] rounded-[8px] bg-[var(--color-background-default-base)] p-2 shadow-lg'
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            {...getFloatingProps()}
          >
            <div className='mb-2 px-2 text-xs font-medium text-text-default-base'>Agent Nodes</div>
            <AgentNodesMenuRows keyboardActive={menuOpen} onSelectType={handleAddNode} />
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

export default LocalDataNodeHandle;
