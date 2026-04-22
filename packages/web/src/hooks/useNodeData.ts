/**
 * Selects a single React Flow node by ID — O(1) lookup via Map.
 */

import { useCanvasData } from '@/contexts/CanvasDataContext';
import type { Node } from '@xyflow/react';

/**
 * @param nodeId - React Flow node id
 * @returns Matching node or undefined
 */
export const useNodeData = (nodeId: string): Node | undefined => {
  const { nodesById } = useCanvasData();
  return nodesById.get(nodeId);
};
