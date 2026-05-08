/**
 * Ephemeral React Flow node: places a real {@link Handle} on the multi-selection bounds’ right edge so
 * drag-to-connect and connect-end (Agent Nodes) behave like {@link LocalDataNodeHandle}. Click still opens
 * the palette batch-spawn menu (parallel edges to a new palette node).
 */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Handle, Position, useConnection, useReactFlow, useStore, type Node, type NodeProps } from '@xyflow/react';
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
import {
  isLocalFlowMultiSelectParallelOutboundCandidateNode,
  mergeMultiSelectParallelSourceIdsWithSnapshot,
  spawnLocalFlowPaletteNodeFromMultiSelectionOutbound,
} from './localFlowNodeSpawn';
import AgentNodesMenuRows from './AgentNodesMenuRows';

/** Stable id merged into the graph only while two or more nodes are selected. */
export const LOCAL_MULTI_SELECT_CONNECT_PROXY_NODE_ID = '__localMultiSelectOutboundProxy__';

const selectedNodesSelector = (state: { nodes: Node[] }) =>
  state.nodes.filter((n) => n.selected && n.type !== 'connectEndAnchor');

export type LocalMultiSelectConnectProxyData = {
  sourceHandleId: string;
  representativeNodeId: string;
};

const LocalMultiSelectConnectProxyNode: React.FC<NodeProps<Node<LocalMultiSelectConnectProxyData>>> = ({
  data,
}) => {
  const { getNodes, setNodes, setEdges, screenToFlowPosition } = useReactFlow();
  const connection = useConnection();
  const sourceHandleId = data.sourceHandleId;
  const containerRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [clickPosition, setClickPosition] = useState<{ x: number; y: number } | null>(null);

  const paletteMultiConnectSourceIds = useStore(
    useCallback((s) => {
      const ids = selectedNodesSelector(s)
        .filter(isLocalFlowMultiSelectParallelOutboundCandidateNode)
        .map((n) => n.id);
      return Array.from(new Set(ids));
    }, []),
  );

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

  const handlePlusClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (connection?.inProgress) return;
    const el = containerRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setClickPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    } else {
      setClickPosition({ x: e.clientX, y: e.clientY });
    }
    setMenuOpen(true);
  };

  const handleAddNode = (nodeType: string) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    spawnLocalFlowPaletteNodeFromMultiSelectionOutbound({
      screenCenter: { x: centerX, y: centerY },
      newPaletteNodeType: nodeType,
      parallelSourceNodeIds: mergeMultiSelectParallelSourceIdsWithSnapshot(paletteMultiConnectSourceIds, getNodes()),
      getNodes,
      setNodes,
      setEdges,
      screenToFlowPosition,
    });
    setMenuOpen(false);
  };

  return (
    <>
      <div className='relative h-[48px] w-[48px]'>
        <Handle
          type='source'
          position={Position.Right}
          id={sourceHandleId}
          className='!border-none !bg-transparent'
          isConnectableStart
          isConnectableEnd={false}
        >
          <div
            ref={containerRef}
            data-connect-handle-area
            className='pointer-events-auto absolute right-0 top-1/2 flex h-[48px] w-[48px] -translate-y-1/2 translate-x-full items-center justify-center opacity-100'
            onClick={handlePlusClick}
          >
            <div className='pointer-events-none flex h-[24px] w-[24px] items-center justify-center rounded-full bg-background-default-base shadow-sm'>
              <Icon name='project-plus-icon' width={14} height={14} color='var(--color-text-default-base)' />
            </div>
          </div>
        </Handle>
      </div>
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

export default memo(LocalMultiSelectConnectProxyNode);
