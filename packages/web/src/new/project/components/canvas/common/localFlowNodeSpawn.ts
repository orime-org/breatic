/**
 * Shared helpers for spawning palette nodes (1001–1004) from the local React Flow canvas
 * {@link LocalDataNodeHandle} and multi-selection outbound UI.
 */
import type { Dispatch, SetStateAction } from 'react';
import { addEdge, type Connection, type Edge, type Node, type XYPosition } from '@xyflow/react';
import { nanoid } from 'nanoid';
import type { LocalCanvasNodeData } from '@/new/project/types';

const newNodeOffsetX = 60;
const defaultNodeWidth = 300;
const defaultNodeHeight = 250;

export const localFlowAgentNodes = [
  { type: '1001', label: 'Text', shortcut: 'Q' },
  { type: '1002', label: 'Image', shortcut: 'W' },
  { type: '1003', label: 'Video', shortcut: 'E' },
  { type: '1004', label: 'Audio', shortcut: 'R' },
] as const;

/** Maps {@link KeyboardEvent.code} to palette id `1001`–`1004` for quick agent-node selection. */
export const agentNodeShortcutCodeToType: Readonly<Record<string, string>> = {
  KeyQ: '1001',
  KeyW: '1002',
  KeyE: '1003',
  KeyR: '1004',
};

export const localFlowAssetHandles: Record<string, { target?: { handleType: string; number: number }[] }> = {
  '1001': { target: [{ handleType: 'Text', number: 0 }] },
  '1002': { target: [{ handleType: 'Image', number: 0 }] },
  '1003': { target: [{ handleType: 'Video', number: 0 }] },
  '1004': { target: [{ handleType: 'Audio', number: 0 }] },
};

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

const defaultNodeHeightByType: Record<string, number> = {
  '1001': 250,
  '1002': 250,
  '1003': 250,
  '1004': 250,
  gen1001: 420,
  gen1002: 420,
  gen1003: 420,
  gen1004: 420,
  group: 200,
};

const defaultNodeHeightFallback = 250;

/** Node types that participate in multi-select outbound “+” spawn (same handle families as palette / generators). */
export const localFlowMultiSelectOutboundTypes = new Set<string>([
  '1001',
  '1002',
  '1003',
  '1004',
  'gen1001',
  'gen1002',
  'gen1003',
  'gen1004',
]);

/** Agent generator node types — excluded as parallel edge sources when spawning from multi-select “+”. */
export const localFlowGeneratorFlowTypes = new Set<string>(['gen1001', 'gen1002', 'gen1003', 'gen1004']);

/**
 * Whether a node type may emit a parallel edge from multi-select proxy / connect-end parallel wiring.
 * Only generator nodes (`gen1001`–`gen1004`) are excluded; all other types are candidates.
 * Types without a resolvable source handle are skipped later via {@link localFlowSourceHandleIdForNodeType}.
 *
 * @param n - React Flow node (only `type` is read)
 */
export function isLocalFlowMultiSelectParallelOutboundCandidateNode(n: Pick<Node, 'type'>): boolean {
  const t = String(n.type);
  return !localFlowGeneratorFlowTypes.has(t);
}

const defaultNodeData = (nodeType: string): LocalCanvasNodeData => {
  const handles = localFlowAssetHandles[nodeType] ?? {};
  const label = localFlowAgentNodes.find((a) => a.type === nodeType)?.label ?? nodeType;
  if (nodeType === '1001') {
    return { name: label, text: '', handles };
  }
  return { name: label, url: '', handles };
};

const generateNodeId = (nodeType: string): string => `${nodeType}-${Date.now()}-${nanoid(5)}`;

/**
 * Best-effort outer width in flow coordinates for bounding-box / handle placement.
 *
 * @param n - React Flow node
 * @returns Width in flow space (px)
 */
export function getLocalFlowNodeOuterWidth(n: Node): number {
  const measured = (n as Node & { measured?: { width?: number } }).measured?.width;
  if (typeof measured === 'number' && measured > 0) return measured;
  const styleW = (n.style as { width?: number | string } | undefined)?.width;
  if (typeof styleW === 'number' && styleW > 0) return styleW;
  if (typeof styleW === 'string') {
    const parsed = parseFloat(styleW);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  const byType = n.type ? defaultNodeWidthByType[n.type] : undefined;
  return byType ?? defaultNodeWidth;
}

/**
 * Best-effort outer height in flow coordinates (mirrors {@link getLocalFlowNodeOuterWidth}).
 *
 * @param n - React Flow node
 * @returns Height in flow space (px)
 */
export function getLocalFlowNodeOuterHeight(n: Node): number {
  const measured = (n as Node & { measured?: { height?: number } }).measured?.height;
  if (typeof measured === 'number' && measured > 0) return measured;
  const styleH = (n.style as { height?: number | string } | undefined)?.height;
  if (typeof styleH === 'number' && styleH > 0) return styleH;
  if (typeof styleH === 'string') {
    const parsed = parseFloat(styleH);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  const byType = n.type ? defaultNodeHeightByType[n.type] : undefined;
  return byType ?? defaultNodeHeightFallback;
}

/**
 * Axis-aligned bounds of a set of nodes in flow space (for multi-select UI placement without `useReactFlow().getNodesBounds`).
 *
 * @param selected - Nodes to include (caller filters)
 * @returns Bounding rect or `null` if empty
 */
export function computeLocalFlowSelectedNodesBounds(
  selected: Node[],
): { x: number; y: number; width: number; height: number } | null {
  if (selected.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of selected) {
    const w = getLocalFlowNodeOuterWidth(n);
    const h = getLocalFlowNodeOuterHeight(n);
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * @param nodeType - Palette type `1001`–`1004`
 * @returns Subtitle string for the agent-node picker
 */
export function getLocalFlowNodeSubtitle(nodeType: string): string {
  switch (nodeType) {
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
}

export interface SpawnLocalFlowPaletteNodeParams {
  /** Existing node id at the anchored end of the new edge. */
  existingNodeId: string;
  /** Handle id on `existingNodeId` used for the new connection. */
  existingHandleId: string;
  /** Screen-space center of the + control (drives flow-space placement). */
  screenCenter: { x: number; y: number };
  /** Palette node type to create (`1001`–`1004`). */
  newPaletteNodeType: string;
  /** When true, new node is placed to the left of `screenCenter` (left / target-handle side). */
  isConnectFromLeft: boolean;
  /**
   * - `existingIsSource` — edge `existing` → new node (right outbound handle).
   * - `existingIsTarget` — edge new node → `existing` (left inbound handle).
   */
  existingEdgeRole: 'existingIsSource' | 'existingIsTarget';
  getNodes: () => Node[];
  setNodes: Dispatch<SetStateAction<Node[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  screenToFlowPosition: (position: XYPosition) => XYPosition;
}

/**
 * Creates a new palette asset node and a default edge to or from the existing node.
 *
 * @param params - Spawn parameters
 */
export function spawnLocalFlowPaletteNodeConnected(params: SpawnLocalFlowPaletteNodeParams): void {
  const {
    existingNodeId,
    existingHandleId,
    screenCenter,
    newPaletteNodeType,
    isConnectFromLeft,
    existingEdgeRole,
    getNodes,
    setNodes,
    setEdges,
    screenToFlowPosition,
  } = params;

  const flowCenter = screenToFlowPosition({ x: screenCenter.x, y: screenCenter.y });
  const handles = localFlowAssetHandles[newPaletteNodeType]?.target;
  const handleType = handles?.[0]?.handleType;
  if (!handleType) return;
  const newPaletteHandleId = `${handleType}_0_0`;
  const nodes = getNodes();
  const maxZIndex = nodes.reduce((max, node) => {
    const z = (node as Node & { zIndex?: number }).zIndex ?? 0;
    return Math.max(max, z);
  }, 0);
  const newNodeId = generateNodeId(newPaletteNodeType);
  const newPosition = isConnectFromLeft
    ? { x: flowCenter.x - defaultNodeWidth - newNodeOffsetX, y: flowCenter.y - defaultNodeHeight / 2 }
    : { x: flowCenter.x + newNodeOffsetX, y: flowCenter.y - defaultNodeHeight / 2 };

  const newNode: Node<LocalCanvasNodeData> & { zIndex?: number } = {
    id: newNodeId,
    type: newPaletteNodeType,
    position: newPosition,
    selected: true,
    zIndex: maxZIndex + 1,
    data: defaultNodeData(newPaletteNodeType),
  };

  setNodes((nds) => {
    const cleared = nds.map((n) => ({ ...n, selected: false }));
    return [...cleared, newNode];
  });

  const connectionParams: Connection =
    existingEdgeRole === 'existingIsSource'
      ? {
        source: existingNodeId,
        sourceHandle: existingHandleId,
        target: newNodeId,
        targetHandle: newPaletteHandleId,
      }
      : {
        source: newNodeId,
        sourceHandle: newPaletteHandleId,
        target: existingNodeId,
        targetHandle: existingHandleId,
      };
  const edgeId = `e-${connectionParams.source}-${connectionParams.sourceHandle ?? ''}-${connectionParams.target}-${connectionParams.targetHandle ?? ''}`;
  setEdges((eds) => {
    if (eds.some((e) => e.id === edgeId)) return eds;
    return addEdge({ ...connectionParams, id: edgeId, type: 'default' }, eds);
  });
}

export interface SpawnLocalFlowPaletteFromMultiSelectionParams {
  /** Screen-space center of the multi-select “+” control (drives flow-space placement). */
  screenCenter: { x: number; y: number };
  /** Palette node type to create (`1001`–`1004`). */
  newPaletteNodeType: string;
  /**
   * Selected node ids that should each get `source → new node` edge — typically every selected node except
   * generators ({@link localFlowGeneratorFlowTypes}); callers pass ids from {@link collectLocalFlowMultiSelectParallelOutboundSourceIds}.
   */
  parallelSourceNodeIds: readonly string[];
  getNodes: () => Node[];
  setNodes: Dispatch<SetStateAction<Node[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  screenToFlowPosition: (position: XYPosition) => XYPosition;
}

/**
 * Creates one new palette node to the right of `screenCenter` and connects every listed source to it.
 * Skips generator nodes and any type without a resolved outbound handle.
 *
 * @param params - Spawn + parallel edge list
 */
export function spawnLocalFlowPaletteNodeFromMultiSelectionOutbound(
  params: SpawnLocalFlowPaletteFromMultiSelectionParams,
): void {
  const { screenCenter, newPaletteNodeType, parallelSourceNodeIds, getNodes, setNodes, setEdges, screenToFlowPosition } =
    params;

  const flowCenter = screenToFlowPosition({ x: screenCenter.x, y: screenCenter.y });
  const handles = localFlowAssetHandles[newPaletteNodeType]?.target;
  const handleType = handles?.[0]?.handleType;
  if (!handleType) return;
  const newPaletteHandleId = `${handleType}_0_0`;

  const nodesBefore = getNodes();
  const maxZIndex = nodesBefore.reduce((max, node) => {
    const z = (node as Node & { zIndex?: number }).zIndex ?? 0;
    return Math.max(max, z);
  }, 0);
  const newNodeId = generateNodeId(newPaletteNodeType);
  const newPosition = {
    x: flowCenter.x + newNodeOffsetX,
    y: flowCenter.y - defaultNodeHeight / 2,
  };

  const newNode: Node<LocalCanvasNodeData> & { zIndex?: number } = {
    id: newNodeId,
    type: newPaletteNodeType,
    position: newPosition,
    selected: true,
    zIndex: maxZIndex + 1,
    data: defaultNodeData(newPaletteNodeType),
  };

  setNodes((nds) => {
    const cleared = nds.map((n) => ({ ...n, selected: false }));
    return [...cleared, newNode];
  });

  const uniqueSourceIds = Array.from(new Set(parallelSourceNodeIds));
  const byId = new Map(nodesBefore.map((n) => [n.id, n]));

  setEdges((eds) => {
    let next = eds;
    for (const sourceId of uniqueSourceIds) {
      const srcNode = byId.get(sourceId);
      if (!srcNode?.type) continue;
      const t = String(srcNode.type);
      if (localFlowGeneratorFlowTypes.has(t)) continue;
      const sourceHandle = localFlowSourceHandleIdForNodeType(t);
      if (!sourceHandle) continue;
      const connectionParams: Connection = {
        source: sourceId,
        sourceHandle,
        target: newNodeId,
        targetHandle: newPaletteHandleId,
      };
      const edgeId = `e-${connectionParams.source}-${connectionParams.sourceHandle ?? ''}-${connectionParams.target}-${connectionParams.targetHandle ?? ''}`;
      if (next.some((e) => e.id === edgeId)) continue;
      next = addEdge({ ...connectionParams, id: edgeId, type: 'default' }, next);
    }
    return next;
  });
}

/**
 * Resolves the outbound source handle id for a canvas node type (palette or generator).
 *
 * @param flowType - React Flow `node.type`
 * @returns Handle id or `null` if unsupported
 */
export function localFlowSourceHandleIdForNodeType(flowType: string | undefined): string | null {
  if (!flowType) return null;
  switch (flowType) {
    case '1001':
    case 'gen1001':
      return 'Text_0_0';
    case '1002':
    case 'gen1002':
      return 'Image_0_0';
    case '1003':
    case 'gen1003':
      return 'Video_0_0';
    case '1004':
    case 'gen1004':
      return 'Audio_0_0';
    default:
      return null;
  }
}

/**
 * Picks the node whose right edge is rightmost among `candidates` (for anchoring multi-select outbound UX).
 *
 * @param candidates - Non-empty subset of selected nodes
 * @returns Rightmost node by flow-space right edge
 */
export function pickLocalFlowRightmostNode(candidates: Node[]): Node {
  let best = candidates[0];
  let bestRight = -Infinity;
  for (const n of candidates) {
    const right = n.position.x + getLocalFlowNodeOuterWidth(n);
    if (right > bestRight) {
      bestRight = right;
      best = n;
    }
  }
  return best;
}

/**
 * When two or more canvas nodes are selected, returns the id used for outbound edges / multi-select handle UX
 * (rightmost palette or generator node among the selection). Otherwise `null`.
 *
 * @param state - React Flow store slice with `nodes`
 */
export function selectLocalMultiSelectOutboundRepresentativeId(state: { nodes: Node[] }): string | null {
  const selected = state.nodes.filter((n) => n.selected && n.type !== 'connectEndAnchor');
  if (selected.length < 2) return null;
  const connectable = selected.filter((n) => localFlowMultiSelectOutboundTypes.has(String(n.type)));
  if (connectable.length === 0) return null;
  return pickLocalFlowRightmostNode(connectable).id;
}

/**
 * Ids of selected nodes that should each receive an outbound edge when wiring from the multi-select proxy handle.
 * Generator nodes ({@link localFlowGeneratorFlowTypes}) are omitted; types without a source handle are skipped when adding edges.
 *
 * @param nodes - Current React Flow nodes
 * @returns Unique ids among the current selection
 */
export function collectLocalFlowMultiSelectParallelOutboundSourceIds(nodes: Node[]): string[] {
  const ids = nodes.filter((n) => n.selected && isLocalFlowMultiSelectParallelOutboundCandidateNode(n)).map((n) => n.id);
  return Array.from(new Set(ids));
}

/**
 * Last known parallel outbound source ids. React Flow may clear {@link Node.selected} during a drag from the
 * multi-select proxy handle; we retain this snapshot until selection stabilizes again.
 */
let multiSelectParallelSnapshot: string[] | null = null;

/**
 * Updates {@link multiSelectParallelSnapshot} from the current selection. When the collected id list is empty,
 * the previous snapshot is kept so connect-end / palette spawn can still merge upstream nodes after drag.
 *
 * @param nodes - Current React Flow canvas nodes (same slice used for {@link collectLocalFlowMultiSelectParallelOutboundSourceIds})
 */
export function syncMultiSelectParallelSnapshot(nodes: Node[]): void {
  const live = collectLocalFlowMultiSelectParallelOutboundSourceIds(nodes);
  if (live.length >= 2) {
    multiSelectParallelSnapshot = live;
    return;
  }
  if (live.length === 1) {
    multiSelectParallelSnapshot = live;
  }
}

/**
 * Dedupes live ids with {@link multiSelectParallelSnapshot} and keeps only ids that still exist and can emit a parallel edge.
 *
 * @param liveIds - Fresh ids from {@link collectLocalFlowMultiSelectParallelOutboundSourceIds}
 * @param nodes - Node list used to resolve handles and membership
 * @returns Source node ids for parallel outbound wiring
 */
export function mergeMultiSelectParallelSourceIdsWithSnapshot(liveIds: string[], nodes: Node[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const snap = multiSelectParallelSnapshot ?? [];
  const merged = Array.from(new Set([...snap, ...liveIds]));
  return merged.filter((id) => {
    const n = byId.get(id);
    return (
      n !== undefined &&
      isLocalFlowMultiSelectParallelOutboundCandidateNode(n) &&
      localFlowSourceHandleIdForNodeType(String(n.type)) != null
    );
  });
}
