import React, { useState, useRef, useEffect } from 'react';
import { Handle, Position, useConnection, useReactFlow } from '@xyflow/react';
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
import { nanoid } from 'nanoid';
import { Icon } from '@/components/base/icon';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useCanvasActions } from '@/hooks/useCanvasActions';
import nodeIconMap from '@/apps/project/constants/nodeIconMap';
import type { Node } from '@xyflow/react';

const containerSize = 48;
const iconSize = 24;
const newNodeOffsetX = 60;
const defaultNodeWidth = 300;
const defaultNodeHeight = 250;

/** Base asset nodes (consistent with NodeContextMenu / right-click add node) */
const agentNodes = [
  { type: '1001', label: 'Text' },
  { type: '1002', label: 'Image' },
  { type: '1003', label: 'Video' },
  { type: '1004', label: 'Audio' },
] as const;

const assetHandles: Record<string, { target?: { handleType: string; number: number }[] }> = {
  '1001': { target: [{ handleType: 'Text', number: 0 }] },
  '1002': { target: [{ handleType: 'Image', number: 0 }] },
  '1003': { target: [{ handleType: 'Video', number: 0 }] },
  '1004': { target: [{ handleType: 'Audio', number: 0 }] },
};

const getNodeSubtitle = (templateType: string): string => {
  switch (templateType) {
    case '1001':
      return 'Loads/Creates text content';
    case '1002':
      return 'Loads/Generates images';
    case '1003':
      return 'Loads/Generates video clips';
    case '1004':
      return 'Loads/Creates audio content';
    default:
      return '';
  }
};

const generateNodeId = (nodeType: string): string => `${nodeType}-${Date.now()}-${nanoid(5)}`;

export interface DataNodeHandleProps {
  type: 'target' | 'source';
  position: Position.Left | Position.Right;
  handleId: string;
  nodeId: string;
  /** Whether the node is selected */
  selected: boolean;
  /** Whether the node body is hovered (passed from parent via onMouseEnter/Leave) */
  nodeHovered: boolean;
  /** Whether inside a locked group (no plus icon or click response in locked groups) */
  isInsideLockedGroup?: boolean;
}

const DataNodeHandle: React.FC<DataNodeHandleProps> = ({
  type,
  position,
  handleId,
  nodeId,
  selected,
  nodeHovered,
  isInsideLockedGroup = false,
}) => {
  const { nodes } = useCanvasData();
  const { onConnect, addNode } = useCanvasActions();
  const { screenToFlowPosition } = useReactFlow();
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

  const showHandle = !isInsideLockedGroup;
  const showIcon = showHandle && (selected || nodeHovered || handleHovered);

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
    if (isInsideLockedGroup || connection?.inProgress) return;
    setClickPosition({ x: e.clientX, y: e.clientY });
    setMenuOpen(true);
  };

  const handleAddNode = (nodeType: string) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const flowCenter = screenToFlowPosition({ x: centerX, y: centerY });
    const handles = assetHandles[nodeType]?.target;
    const handleType = handles?.[0]?.handleType;
    if (!handleType) return;
    const newHandleId = `${handleType}_0_0`;
    const maxZIndex = nodes.reduce((max, node) => {
      const z = (node as Node & { zIndex?: number }).zIndex ?? 0;
      return Math.max(max, z);
    }, 0);
    const newNodeId = generateNodeId(nodeType);
    const isLeft = position === Position.Left;
    const newPosition = isLeft
      ? { x: flowCenter.x - defaultNodeWidth - newNodeOffsetX, y: flowCenter.y - defaultNodeHeight / 2 }
      : { x: flowCenter.x + newNodeOffsetX, y: flowCenter.y - defaultNodeHeight / 2 };
    const newNode: Node & { zIndex?: number } = {
      id: newNodeId,
      type: nodeType,
      position: newPosition,
      selected: true,
      zIndex: maxZIndex + 1,
      data: { handles: assetHandles[nodeType] ?? {} },
    };
    addNode(newNode, { select: true });
    if (type === 'target') {
      onConnect({ source: newNodeId, sourceHandle: newHandleId, target: nodeId, targetHandle: handleId });
    } else {
      onConnect({ source: nodeId, sourceHandle: handleId, target: newNodeId, targetHandle: newHandleId });
    }
    setMenuOpen(false);
  };

  const handlePointerUp = () => {
    if (!connection?.inProgress || !connection.fromNode || !connection.fromHandle) return;
    const fromId = connection.fromNode.id;
    const fromHandleId =
      typeof connection.fromHandle === 'object' && connection.fromHandle !== null && 'id' in connection.fromHandle
        ? String((connection.fromHandle as { id: string }).id)
        : null;
    if (!fromId || !fromHandleId || fromId === nodeId) return;

    if (type === 'target') {
      onConnect({
        source: fromId,
        sourceHandle: fromHandleId,
        target: nodeId,
        targetHandle: handleId,
      });
    } else {
      onConnect({
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
      <Handle type={type} position={position} id={handleId} className='!bg-transparent !border-none'>
        <div
          ref={containerRef}
          data-connect-handle-area
          className={`absolute top-1/2 -translate-y-1/2 ${positionClass} flex justify-center items-center transition-opacity duration-150 ${
            showHandle
              ? 'w-[48px] h-[48px] opacity-100'
              : 'w-0 h-0 min-w-0 min-h-0 overflow-hidden opacity-0 pointer-events-none'
          }`}
          onMouseEnter={() => setHandleHovered(true)}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onPointerUp={handlePointerUp}
          onClick={handlePlusClick}
        >
          <div
            className={
              'w-[24px] h-[24px] rounded-full bg-background-default-base shadow-sm flex justify-center items-center pointer-events-none transition-opacity duration-150 ' +
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
            className='z-[1000] min-w-[220px] rounded-[8px] bg-[var(--color-background-default-base)] p-2 shadow-lg'
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            {...getFloatingProps()}
          >
            <div className='text-xs font-medium text-text-default-base mb-2 px-2'>Agent Nodes</div>
            <div className='flex flex-col gap-0.5'>
              {agentNodes.map((asset) => {
                const iconName = nodeIconMap[asset.type];
                return (
                  <div
                    key={asset.type}
                    role='button'
                    className='flex w-full min-h-9 items-center gap-3 rounded-[4px] px-2 py-1.5 text-left cursor-pointer hover:bg-background-default-secondary transition-colors'
                    onClick={() => handleAddNode(asset.type)}
                  >
                    {iconName && <Icon name={iconName} width={20} height={20} color='var(--color-icon-base)' />}
                    <div className='flex flex-col justify-center min-w-0 flex-1'>
                      <span className='text-xs font-medium leading-4 text-text-default-base truncate'>
                        {asset.label}
                      </span>
                      <span className='text-[10px] leading-3 text-text-default-tertiary truncate'>
                        {getNodeSubtitle(asset.type)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

export default DataNodeHandle;
