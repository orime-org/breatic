/**
 * Local-only infinite canvas (React Flow) under `new/project` — no Yjs.
 * Node implementations live under `./dataNode/` (same layout as `apps/project` canvas).
 */
import type { ComponentProps, FC, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type XYPosition,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeTypes,
  type OnConnectEnd,
} from '@xyflow/react';
import { nanoid } from 'nanoid';
import CustomEdge from '@/spaces/canvas/common/Edge';
import ConnectEndCommandMenu from '@/spaces/canvas/common/ConnectEndCommandMenu';
import ConnectEndAnchorNode, {
  connectEndAnchorSourceHandleId,
  connectEndAnchorTargetHandleId,
} from '@/spaces/canvas/common/ConnectEndAnchorNode';
import type { LocalCanvasNodeData } from '@/new/project/types';
import TextNode from './dataNode/textNode/TextNode';
import ImageNode from './dataNode/imageNode/ImageNode';
import VideoNode from './dataNode/videoNode/VideoNode';
import AudioNode from './dataNode/audioNode/AudioNode';
import LocalGenNode from './dataNode/generatorNode/LocalGenNode';
import NodeLibraryPanel from './ui/NodeLibraryPanel';
import { message } from '@/ui/message';
import CropModal from '@/spaces/timeline/components/rightPanel/CropModal';
import LocalGroupNode from './common/LocalGroupNode';
import LocalGroupToolbarPanel from './common/LocalGroupToolbarPanel';
import LocalNodeContextMenu from './common/LocalNodeContextMenu';
import NodeDragStopBinder from './flow/NodeDragStopBinder';
import { localCropImageToObjectUrl } from './dataNode/imageNode/crop/localCropImageToObjectUrl';
import UndoRedoToolbar from '@/spaces/canvas/common/UndoRedoToolbar';
import CustomMiniMap from '@/spaces/canvas/common/CustomMiniMap';
import CanvasHotkeys from './hotkeys/CanvasHotkeys';
import { useFlowHistory } from './hooks/useFlowHistory';
import { CanvasNodeActionsProvider } from './context/CanvasNodeActionsContext';
import { CANVAS_SPAWNED_OUTPUT_GAP_PX } from './canvasSpawnLayout';

const reactFlowDefaultViewport = { x: 0, y: 0, zoom: 0.5 } as const;
const reactFlowPanOnDrag: [number] = [1];
const reactFlowProOptions = { hideAttribution: true } as const;
/** Avoid `contain: paint` on the React Flow root — it can desync the box-selection marquee from the graph. */
const reactFlowStyle = { contain: 'layout' } as const;

const connectEndHandlesBase: Record<
  string,
  { target?: { handleType: string; number: number }[]; source?: { handleType: string; number: number }[] }
> = {
  '1001': { target: [{ handleType: 'Text', number: 0 }], source: [{ handleType: 'Text', number: 0 }] },
  '1002': { target: [{ handleType: 'Image', number: 0 }], source: [{ handleType: 'Image', number: 0 }] },
  '1003': { target: [{ handleType: 'Video', number: 0 }], source: [{ handleType: 'Video', number: 0 }] },
  '1004': { target: [{ handleType: 'Audio', number: 0 }], source: [{ handleType: 'Audio', number: 0 }] },
};

/** Palette ids plus connect-end {@link LocalGenNode} types (`gen1001`–`gen1004`). */
const connectEndHandles: Record<
  string,
  { target?: { handleType: string; number: number }[]; source?: { handleType: string; number: number }[] }
> = {
  ...connectEndHandlesBase,
  gen1001: connectEndHandlesBase['1001'],
  gen1002: connectEndHandlesBase['1002'],
  gen1003: connectEndHandlesBase['1003'],
  gen1004: connectEndHandlesBase['1004'],
};

const generateConnectEndNodeId = (nodeType: string): string => `${nodeType}-${Date.now()}-${nanoid(5)}`;

const imageCropResultShellDefaults = { w: 300, h: 250 } as const;
const imageCropFlowHandleId = 'Image_0_0';

/**
 * Matches {@link ImageNode} tile sizing so modal crop results align with inline tool output nodes.
 */
function computeImageNodeDisplaySizeForCropResult(naturalWidth: number, naturalHeight: number): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return { width: imageCropResultShellDefaults.w, height: imageCropResultShellDefaults.h };
  }
  const isLandscape = naturalWidth >= naturalHeight;
  if (isLandscape) {
    const h = Math.max(
      Math.round(imageCropResultShellDefaults.w * (naturalHeight / naturalWidth)),
      imageCropResultShellDefaults.h,
    );
    return { width: Math.round(h * (naturalWidth / naturalHeight)), height: h };
  }
  return {
    width: imageCropResultShellDefaults.w,
    height: Math.round(imageCropResultShellDefaults.w * (naturalHeight / naturalWidth)),
  };
}

const defaultNodeWidthByType: Record<string, number> = {
  '1001': 300,
  '1002': 300,
  '1003': 300,
  '1004': 300,
  gen1001: 420,
  gen1002: 420,
  gen1003: 420,
  gen1004: 420,
};

const connectEndGeneratorTitles: Record<string, string> = {
  '1001': 'Text Generator',
  '1002': 'Image Generator',
  '1003': 'Video Generator',
  '1004': 'Audio Generator',
};

/**
 * Node data for a {@link LocalGenNode} created from the connect-end command menu.
 *
 * @param paletteKind - Palette id (`1001`–`1004`) from {@link ConnectEndCommandMenu}
 */
const localDataForConnectEndGeneratorNode = (paletteKind: string): LocalCanvasNodeData => {
  const handles = connectEndHandles[`gen${paletteKind}`] ?? {};
  const name = connectEndGeneratorTitles[paletteKind] ?? 'Generator';
  if (paletteKind === '1001') {
    return { name, text: '', handles, nodeRuntimeData: {} };
  }
  return { name, url: '', handles, nodeRuntimeData: {} };
};

type ConnectEndMenuState = {
  clientX: number;
  clientY: number;
  tempAnchorNodeId: string;
  isFromInput: boolean;
  fromNodeId?: string;
  fromHandleId?: string;
  toNodeId?: string;
  toHandleId?: string;
} | null;

type LocalContextMenuState = {
  left: number;
  top: number;
  contextNodeId: string | null;
  clientX: number;
  clientY: number;
} | null;

type LocalCropTargetState = { nodeId: string; url: string } | null;

const nodeTypes: NodeTypes = {
  '1001': TextNode,
  '1002': ImageNode,
  '1003': VideoNode,
  '1004': AudioNode,
  gen1001: LocalGenNode,
  gen1002: LocalGenNode,
  gen1003: LocalGenNode,
  gen1004: LocalGenNode,
  group: LocalGroupNode,
  connectEndAnchor: ConnectEndAnchorNode,
};

const edgeTypes = {
  default: CustomEdge,
};

type ScreenToFlowPort = { screenToFlowPosition: (position: XYPosition) => XYPosition };

/** Bridges `screenToFlowPosition` from inside {@link ReactFlow} to parent callbacks (`onConnectEnd`, menu). */
const ScreenToFlowPortBridge: FC<{ portRef: RefObject<ScreenToFlowPort | null> }> = ({ portRef }) => {
  const { screenToFlowPosition } = useReactFlow();
  useLayoutEffect(() => {
    portRef.current = { screenToFlowPosition };
  }, [portRef, screenToFlowPosition]);
  return null;
};

const ProjectCanvasInner: FC = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { canUndo, canRedo, undo, redo } = useFlowHistory(nodes, edges, setNodes, setEdges);
  const [minimapOpen, setMinimapOpen] = useState(true);
  const screenToFlowPortRef = useRef<ScreenToFlowPort | null>(null);
  const nodeDragStopRef = useRef<((e: ReactMouseEvent, node: Node) => void) | null>(null);
  const [contextMenu, setContextMenu] = useState<LocalContextMenuState>(null);
  const [cropTarget, setCropTarget] = useState<LocalCropTargetState>(null);

  const screenToFlowPosition = useCallback((position: XYPosition) => {
    const fn = screenToFlowPortRef.current?.screenToFlowPosition;
    return fn ? fn(position) : position;
  }, []);

  const [connectEndMenu, setConnectEndMenu] = useState<ConnectEndMenuState>(null);
  const [tempConnectNodes, setTempConnectNodes] = useState<Node[]>([]);
  const [tempConnectEdges, setTempConnectEdges] = useState<Edge[]>([]);

  const nodesRef = useRef(nodes);
  const tempConnectNodesRef = useRef(tempConnectNodes);
  const tempConnectEdgesRef = useRef(tempConnectEdges);
  const lastInputPanelAnchorRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    tempConnectNodesRef.current = tempConnectNodes;
  }, [tempConnectNodes]);
  useEffect(() => {
    tempConnectEdgesRef.current = tempConnectEdges;
  }, [tempConnectEdges]);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const tempIds = new Set(tempConnectNodesRef.current.map((n) => n.id));
      const mainChanges: NodeChange[] = [];
      const tempChanges: NodeChange[] = [];
      for (const c of changes) {
        const id = 'id' in c ? c.id : '';
        if (id && tempIds.has(id)) tempChanges.push(c);
        else mainChanges.push(c);
      }
      if (mainChanges.length) onNodesChange(mainChanges);
      if (tempChanges.length) {
        setTempConnectNodes((prev) => applyNodeChanges(tempChanges, prev));
      }
    },
    [onNodesChange],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const tempIds = new Set(tempConnectEdgesRef.current.map((e) => e.id));
      const mainChanges: EdgeChange[] = [];
      const tempChanges: EdgeChange[] = [];
      for (const c of changes) {
        const id = 'id' in c ? c.id : '';
        if (id && tempIds.has(id)) tempChanges.push(c);
        else mainChanges.push(c);
      }
      if (mainChanges.length) onEdgesChange(mainChanges);
      if (tempChanges.length) {
        setTempConnectEdges((prev) => applyEdgeChanges(tempChanges, prev));
      }
    },
    [onEdgesChange],
  );

  const reactFlowNodes = useMemo(() => {
    if (tempConnectNodes.length === 0) return nodes;
    return [...nodes, ...tempConnectNodes];
  }, [nodes, tempConnectNodes]);

  const reactFlowEdges = useMemo(() => {
    if (tempConnectEdges.length === 0) return edges;
    return [...edges, ...tempConnectEdges];
  }, [edges, tempConnectEdges]);

  const onConnect = useCallback(
    (params: Connection) => {
      const edgeId = `e-${params.source}-${params.sourceHandle ?? ''}-${params.target}-${params.targetHandle ?? ''}`;
      setEdges((eds) => {
        if (eds.some((e) => e.id === edgeId)) return eds;
        return addEdge({ ...params, id: edgeId, type: 'default' }, eds);
      });
    },
    [setEdges],
  );

  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      if (connectionState.isValid) return;
      const fromNodeId = connectionState.fromNode?.id;
      const fromHandle = connectionState.fromHandle;
      const fromHandleId =
        fromHandle != null && typeof fromHandle === 'object' && 'id' in fromHandle
          ? String((fromHandle as { id: string }).id)
          : '';
      if (!fromNodeId || !fromHandleId) return;
      const target = 'changedTouches' in event ? (event as TouchEvent).target : (event as MouseEvent).target;
      if (target && (target as Element).closest?.('[data-connect-handle-area]')) return;
      const { clientX, clientY } =
        'changedTouches' in event ? (event as TouchEvent).changedTouches[0] : (event as MouseEvent);
      const position = screenToFlowPosition({ x: clientX, y: clientY });
      const tempAnchorNodeId = `connectEndAnchor-${Date.now()}`;
      const anchorNode: Node = {
        id: tempAnchorNodeId,
        type: 'connectEndAnchor',
        position,
        data: {},
        style: { width: 1, height: 1 },
      };

      const isFromInput = fromHandle?.type === 'target';
      if (isFromInput) {
        const tempEdge = {
          id: `e-connectEnd-${tempAnchorNodeId}-${fromNodeId}`,
          source: tempAnchorNodeId,
          target: fromNodeId,
          sourceHandle: connectEndAnchorSourceHandleId,
          targetHandle: fromHandleId,
          type: 'default' as const,
        };
        setTempConnectNodes([anchorNode]);
        setTempConnectEdges(addEdge(tempEdge as Connection, []));
        setConnectEndMenu({
          clientX,
          clientY,
          tempAnchorNodeId,
          isFromInput: true,
          toNodeId: fromNodeId,
          toHandleId: fromHandleId,
        });
      } else {
        const tempEdge = {
          id: `e-connectEnd-${fromNodeId}-${tempAnchorNodeId}`,
          source: fromNodeId,
          target: tempAnchorNodeId,
          sourceHandle: fromHandleId,
          targetHandle: connectEndAnchorTargetHandleId,
          type: 'default' as const,
        };
        setTempConnectNodes([anchorNode]);
        setTempConnectEdges(addEdge(tempEdge as Connection, []));
        setConnectEndMenu({
          clientX,
          clientY,
          tempAnchorNodeId,
          isFromInput: false,
          fromNodeId,
          fromHandleId,
        });
      }
    },
    [screenToFlowPosition],
  );

  const onConnectEndMenuClose = useCallback(() => {
    setTempConnectNodes([]);
    setTempConnectEdges([]);
    setConnectEndMenu(null);
  }, []);

  const connectEndMenuRef = useRef(connectEndMenu);
  useEffect(() => {
    connectEndMenuRef.current = connectEndMenu;
  }, [connectEndMenu]);

  const onPanelPositionChange = useCallback(
    (x: number, y: number, isFromInput: boolean) => {
      const menu = connectEndMenuRef.current;
      if (!menu?.tempAnchorNodeId) return;
      if (isFromInput) lastInputPanelAnchorRef.current = { x, y };
      const flowPos = screenToFlowPosition({ x, y });
      const position = isFromInput ? { x: flowPos.x - 1, y: flowPos.y - 0.5 } : { x: flowPos.x, y: flowPos.y - 0.5 };
      const anchorId = menu.tempAnchorNodeId;
      setTempConnectNodes((prev) => prev.map((n) => (n.id === anchorId ? { ...n, position } : n)));
    },
    [screenToFlowPosition],
  );

  const handleConnectEndSelect = useCallback(
    (paletteKind: string) => {
      if (!connectEndMenu) return;
      const { clientX, clientY, isFromInput, fromNodeId, fromHandleId, toNodeId, toHandleId } = connectEndMenu;
      if (isFromInput && (!toNodeId || !toHandleId)) return;
      if (!isFromInput && (!fromNodeId || !fromHandleId)) return;
      const anchor = isFromInput ? lastInputPanelAnchorRef.current : null;
      const screenX = anchor?.x ?? clientX;
      const screenY = anchor?.y ?? clientY;
      if (isFromInput) lastInputPanelAnchorRef.current = null;
      const flowPos = screenToFlowPosition({ x: screenX, y: screenY });
      const rfType = `gen${paletteKind}`;
      const defaultWidth = defaultNodeWidthByType[rfType] ?? defaultNodeWidthByType[paletteKind] ?? 300;
      const position = isFromInput ? { x: flowPos.x - defaultWidth, y: flowPos.y } : { x: flowPos.x, y: flowPos.y };
      const currentNodes = [...nodesRef.current, ...tempConnectNodesRef.current];
      const maxZIndex = currentNodes.reduce((max, n) => Math.max(max, (n as Node & { zIndex?: number }).zIndex ?? 0), 0);
      const newNodeId = generateConnectEndNodeId(rfType);
      const handles = connectEndHandles[rfType];
      const newNode: Node & { zIndex?: number } = {
        id: newNodeId,
        type: rfType,
        position,
        selected: true,
        zIndex: maxZIndex + 1,
        data: localDataForConnectEndGeneratorNode(paletteKind),
      };

      const sourceHandle = handles?.source?.[0];
      const sourceHandleId = sourceHandle ? `${sourceHandle.handleType}_0_${sourceHandle.number}` : '';
      const targetHandle = handles?.target?.[0];
      const targetHandleId = targetHandle ? `${targetHandle.handleType}_0_${targetHandle.number}` : '';

      const newEdge = isFromInput
        ? {
          id: `e-${newNodeId}-${toNodeId}-${Date.now()}`,
          source: newNodeId,
          target: toNodeId!,
          sourceHandle: sourceHandleId,
          targetHandle: toHandleId,
          type: 'default' as const,
        }
        : {
          id: `e-${fromNodeId}-${newNodeId}-${Date.now()}`,
          source: fromNodeId!,
          target: newNodeId,
          sourceHandle: fromHandleId,
          targetHandle: targetHandleId,
          type: 'default' as const,
        };

      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), newNode]);
      setEdges((eds) => [...eds, newEdge as Edge]);
      setTempConnectNodes([]);
      setTempConnectEdges([]);
      setConnectEndMenu(null);
    },
    [connectEndMenu, screenToFlowPosition, setNodes, setEdges],
  );

  const defaultEdgeOptions = useMemo(() => ({ type: 'default' as const }), []);

  const onPaneClick = useCallback(() => {
    setContextMenu(null);
  }, []);

  const onNodeContextMenu = useCallback((e: ReactMouseEvent, node: Node) => {
    e.preventDefault();
    setContextMenu({
      left: e.clientX,
      top: e.clientY,
      contextNodeId: node.id,
      clientX: e.clientX,
      clientY: e.clientY,
    });
  }, []);

  const onPaneContextMenu = useCallback<NonNullable<ComponentProps<typeof ReactFlow>['onPaneContextMenu']>>(
    (e) => {
      e.preventDefault();
      setContextMenu({
        left: e.clientX,
        top: e.clientY,
        contextNodeId: null,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    },
    [],
  );

  const handleCropApply = useCallback(
    async (
      _croppedUrl: string | null,
      cropData: { x: number; y: number; width: number; height: number; unit: 'px' },
    ) => {
      if (!cropTarget) return;
      try {
        const nextUrl = await localCropImageToObjectUrl(cropTarget.url, cropData);
        const nw = Math.max(1, Math.round(cropData.width));
        const nh = Math.max(1, Math.round(cropData.height));
        const dims = computeImageNodeDisplaySizeForCropResult(nw, nh);
        const newId = `1002-${Date.now()}-${nanoid(5)}`;
        const edgeId = `e-${cropTarget.nodeId}-${imageCropFlowHandleId}-${newId}-${imageCropFlowHandleId}`;
        setNodes((nds) => {
          const source = nds.find((n) => n.id === cropTarget.nodeId);
          if (!source) return nds;
          const prev = (source.data ?? {}) as LocalCanvasNodeData;
          const baseName = prev.name?.trim() ? prev.name.trim() : 'Image';
          const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
          const sourceShellW =
            typeof sourceStyle.width === 'number' && Number.isFinite(sourceStyle.width)
              ? sourceStyle.width
              : imageCropResultShellDefaults.w;
          const maxZ = nds.reduce((m, n) => Math.max(m, (n as Node & { zIndex?: number }).zIndex ?? 0), 0);
          const newNode: Node<LocalCanvasNodeData> = {
            id: newId,
            type: '1002',
            position: { x: source.position.x + sourceShellW + CANVAS_SPAWNED_OUTPUT_GAP_PX, y: source.position.y },
            zIndex: maxZ + 1,
            selected: true,
            style: { width: dims.width, height: dims.height },
            data: {
              name: `${baseName} (crop)`,
              url: nextUrl,
              handles: connectEndHandlesBase['1002'],
            },
          };
          return [...nds.map((n) => ({ ...n, selected: false })), newNode];
        });
        setEdges((eds) => {
          if (eds.some((e) => e.id === edgeId)) return eds;
          return addEdge(
            {
              id: edgeId,
              source: cropTarget.nodeId,
              target: newId,
              sourceHandle: imageCropFlowHandleId,
              targetHandle: imageCropFlowHandleId,
              type: 'default',
            },
            eds,
          );
        });
      } catch (err) {
        console.error(err);
        message.warning('Could not crop image. If this is a remote URL, CORS may block pixel export.');
      }
      setCropTarget(null);
    },
    [cropTarget, setEdges, setNodes],
  );

  const requestCrop = useCallback((nodeId: string) => {
    const n = nodesRef.current.find((x) => x.id === nodeId);
    if (!n) return;
    const data = (n.data ?? {}) as LocalCanvasNodeData;
    const u = data.url?.trim() ?? '';
    if (!u) return;
    if (n.type === '1002') {
      setCropTarget({ nodeId, url: u });
      return;
    }
    if (n.type === '1003') {
      message.warning('Video crop and FFmpeg tools run in the full project editor; local canvas is image-focused for now.');
    }
  }, []);

  const duplicateMediaNode = useCallback(
    (nodeId: string) => {
      const n = nodesRef.current.find((x) => x.id === nodeId);
      if (!n || (n.type !== '1002' && n.type !== '1003')) return;
      const maxZ = nodesRef.current.reduce(
        (m, x) => Math.max(m, (x as Node & { zIndex?: number }).zIndex ?? 0),
        0,
      );
      const newId = `${String(n.type)}-${Date.now()}-${nanoid(5)}`;
      const cloned: Node & { zIndex?: number } = {
        ...n,
        id: newId,
        position: { x: n.position.x + 24, y: n.position.y + 24 },
        selected: true,
        zIndex: maxZ + 1,
      };
      setNodes((nds) => [...nds.map((x) => ({ ...x, selected: false })), cloned]);
    },
    [setNodes],
  );

  const canvasNodeActions = useMemo(
    () => ({
      requestCrop,
      duplicateMediaNode,
    }),
    [requestCrop, duplicateMediaNode],
  );

  return (
    <CanvasNodeActionsProvider value={canvasNodeActions}>
      <ReactFlow
        nodes={reactFlowNodes}
        edges={reactFlowEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onNodeDragStop={(e, n) => nodeDragStopRef.current?.(e, n)}
        onPaneClick={onPaneClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        defaultViewport={reactFlowDefaultViewport}
        panOnDrag={reactFlowPanOnDrag}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        proOptions={reactFlowProOptions}
        className='relative z-[1] origin-[0px_0px] backface-hidden antialiased'
        style={reactFlowStyle}
        fitView={false}
        minZoom={0.2}
        maxZoom={2}
        deleteKeyCode={['Backspace', 'Delete']}
        nodesConnectable
        elementsSelectable
        selectionOnDrag
        selectNodesOnDrag={false}
        connectionRadius={20}
      >
        <ScreenToFlowPortBridge portRef={screenToFlowPortRef} />
        <NodeDragStopBinder bindRef={nodeDragStopRef} setNodes={setNodes} />
        <Background color='#d0d0d0' variant={BackgroundVariant.Dots} gap={20} size={1} />
        {minimapOpen ? <CustomMiniMap /> : null}
        <UndoRedoToolbar
          minimapOpen={minimapOpen}
          onToggleMinimap={() => setMinimapOpen((v) => !v)}
          localUndo={undo}
          localRedo={redo}
          localCanUndo={canUndo}
          localCanRedo={canRedo}
        />
        <CanvasHotkeys canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo} />
        <NodeLibraryPanel />
        <LocalGroupToolbarPanel />
        <LocalNodeContextMenu
          open={!!contextMenu}
          left={contextMenu?.left ?? 0}
          top={contextMenu?.top ?? 0}
          contextNodeId={contextMenu?.contextNodeId ?? null}
          clientX={contextMenu?.clientX ?? 0}
          clientY={contextMenu?.clientY ?? 0}
          onClose={() => setContextMenu(null)}
          onOpenCrop={(target) => setCropTarget({ nodeId: target.nodeId, url: target.url })}
        />
        <CropModal
          visible={!!cropTarget}
          mediaUrl={cropTarget?.url ?? ''}
          mediaType='image'
          onClose={() => setCropTarget(null)}
          onApply={handleCropApply}
        />
        <ConnectEndCommandMenu
          open={!!connectEndMenu}
          left={connectEndMenu?.clientX ?? 0}
          top={connectEndMenu?.clientY ?? 0}
          anchorSide={connectEndMenu?.isFromInput ? 'input' : 'output'}
          onSelect={handleConnectEndSelect}
          onClose={onConnectEndMenuClose}
          onPanelPositionChange={onPanelPositionChange}
        />
      </ReactFlow>
    </CanvasNodeActionsProvider>
  );
};

const ProjectCanvas: FC = () => (
  <div className='relative h-full w-full bg-background-default-secondary' data-project-canvas-flow-root>
    <ProjectCanvasInner />
  </div>
);

export default memo(ProjectCanvas);
