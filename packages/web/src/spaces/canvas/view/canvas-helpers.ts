/**
 * Canvas helper functions + ReactFlow static config.
 *
 * Pulled out of `spaces/canvas/index.tsx` so the shell can stay <100
 * lines and the helpers themselves are independently importable
 * (handy for tests and the future canvas decomposition PR-Y2/Y3).
 *
 * All functions are pure (no React hooks, no module-scope state).
 */

import { nanoid } from 'nanoid';
import type { Node } from '@xyflow/react';
import type { CanvasWorkflowNodeData, ResourceType } from '@/spaces/canvas/types';

/** Get group-node bounds (top-left + size), or null when invalid. */
export const getGroupBounds = (groupNode: Node) => {
  if (groupNode.type !== 'group') return null;
  const style = groupNode.style;
  const w = Number(style?.width) || 0;
  const h = Number(style?.height) || 0;
  if (w <= 0 || h <= 0) return null;
  return {
    left: groupNode.position.x,
    top: groupNode.position.y,
    width: w,
    height: h,
  };
};

// `getLockedGroupIds` is now re-exported from lock-helpers below
// so callers that already import it from this module keep working
// while the canonical implementation lives in one place.
export { getLockedGroupIds, isNodeLocked, isNodeLockable } from '@/spaces/canvas/common/lock-helpers';

/**
 * Current output URL for project canvas image nodes (1002), or null.
 * Canvas-native schema: reads data.content directly.
 */
export const getProjectImageNodeContentUrl = (node: Node): string | null => {
  if (node.type !== '1002') return null;
  const data = node.data as Partial<CanvasWorkflowNodeData>;
  return data.content ?? null;
};

/** Extract pickable content from any canvas node for mention mode (all node types). */
export const getNodeContentForMention = (
  node: Node,
): { content: string; name: string; resourceType: ResourceType } | null => {
  const data = node.data as Partial<CanvasWorkflowNodeData> | undefined;
  const name = typeof data?.name === 'string' && data.name.trim() ? data.name : '';
  if (node.type === '1002') {
    const url = data?.content ?? null;
    if (!url) return null;
    return { content: url, name: name || 'image', resourceType: 'image' };
  }
  if (node.type === '1003') {
    // Video URL — read from data.content (canvas-native schema).
    const url = data?.content ?? null;
    if (!url) return null;
    return { content: url, name: name || 'video', resourceType: 'video' };
  }
  if (node.type === '1004') {
    // Audio URL — read from data.content (canvas-native schema).
    const url = data?.content ?? null;
    if (!url) return null;
    return { content: url, name: name || 'audio', resourceType: 'audio' };
  }
  if (node.type === '1001') {
    // TODO PR-C+: text content lives in the Yjs `prompt` Y.XmlFragment, not in
    // `data.content`. Extracting plain text for mention mode requires accessing
    // the TipTap document. Return null until that path is implemented.
    return null;
  }
  return null;
};

/**
 * Compute click position percentage in the target image viewport
 * (`data-agent-image-viewport`). Falls back to the react-flow node
 * shell (`data-id`) if viewport element is missing.
 *
 * @param e - node click event
 * @param nodeId - clicked node id
 * @returns percentage in range 0-100, or undefined when no anchor element is found
 */
export const getAgentCanvasPickOverlayAnchorFromClick = (
  e: React.MouseEvent,
  nodeId: string,
): { xPct: number; yPct: number } | undefined => {
  const pctInRect = (clientX: number, clientY: number, rect: DOMRect) => {
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const xPct = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
    const yPct = Math.min(100, Math.max(0, ((clientY - rect.top) / rect.height) * 100));
    return { xPct, yPct };
  };

  let el: HTMLElement | null = e.target as HTMLElement;
  while (el) {
    if (el.getAttribute('data-agent-image-viewport') === nodeId) {
      const hit = pctInRect(e.clientX, e.clientY, el.getBoundingClientRect());
      if (hit) return hit;
      break;
    }
    el = el.parentElement;
  }

  el = e.target as HTMLElement;
  while (el) {
    if (el.getAttribute('data-id') === nodeId) {
      return pctInRect(e.clientX, e.clientY, el.getBoundingClientRect());
    }
    el = el.parentElement;
  }
  return undefined;
};

/**
 * Connection-end handle metadata for each canvas node type. Drives
 * the temp anchor + auto-edge created when the user drags a connection
 * out of a node onto empty canvas.
 */
export const connectEndHandles: Record<
  string,
  {
    target?: { handleType: string; number: number }[];
    source?: { handleType: string; number: number }[];
  }
> = {
  '1001': { target: [{ handleType: 'Text', number: 0 }], source: [{ handleType: 'Text', number: 0 }] },
  '1002': { target: [{ handleType: 'Image', number: 0 }], source: [{ handleType: 'Image', number: 0 }] },
  '1003': { target: [{ handleType: 'Video', number: 0 }], source: [{ handleType: 'Video', number: 0 }] },
  '1004': { target: [{ handleType: 'Audio', number: 0 }], source: [{ handleType: 'Audio', number: 0 }] },
};

/** Generate a unique connect-end node id with timestamp + nanoid suffix. */
export const generateConnectEndNodeId = (nodeType: string): string =>
  `${nodeType}-${Date.now()}-${nanoid(5)}`;

/**
 * Default node width per canvas node type. Used by `handleConnectEndSelect`
 * when computing the spawn position so input-side spawns shift left by
 * the node's width.
 */
export const defaultNodeWidthByType: Record<string, number> = {
  '1001': 300,
  '1002': 300,
  '1003': 300,
  '1004': 472,
  commentMarker: 44,
};

/** Stable ReactFlow viewport / interaction config (referential identity matters
 *  to avoid re-renders). */
export const reactFlowDefaultViewport = { x: 0, y: 0, zoom: 0.5 } as const;
export const reactFlowPanOnDrag: [number] = [1];
export const reactFlowProOptions = { hideAttribution: true } as const;
export const reactFlowStyle = { contain: 'layout style paint' } as const;

/**
 * Local UI state shapes used by the canvas shell — context menu and
 * connection-end menu coordinates / target hints. Defined here so
 * both the shell and the (future) extracted hooks share them.
 */
export type ContextMenuState = {
  left: number;
  top: number;
  contextNodeId: string | null;
  clientX: number;
  clientY: number;
} | null;

export type ConnectEndMenuState = {
  clientX: number;
  clientY: number;
  tempAnchorNodeId: string;
  isFromInput: boolean;
  fromNodeId?: string;
  fromHandleId?: string;
  toNodeId?: string;
  toHandleId?: string;
} | null;

