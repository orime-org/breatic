/**
 * Selects a single React Flow node from the canvas data context.
 */

import { useMemo } from 'react';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import type { Node } from '@xyflow/react';

/**
 * @param nodeId - React Flow node id
 * @returns Matching node or undefined
 */
export const useNodeData = (nodeId: string): Node | undefined => {
  const { nodes } = useCanvasData();
  return useMemo(() => nodes.find((n) => n.id === nodeId), [nodes, nodeId]);
};
