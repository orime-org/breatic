/**
 * Installs {@link ReactFlowProps.onNodeDragStop} using {@link useReactFlow} (must run under `<ReactFlow>`).
 */
import {
  memo,
  useLayoutEffect,
  useCallback,
  type Dispatch,
  type FC,
  type RefObject,
  type SetStateAction,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useReactFlow, type Node } from '@xyflow/react';

const getGroupBounds = (groupNode: Node) => {
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

export type NodeDragStopBinderProps = {
  bindRef: RefObject<((e: ReactMouseEvent, node: Node) => void) | null>;
  setNodes: Dispatch<SetStateAction<Node[]>>;
};

const NodeDragStopBinder: FC<NodeDragStopBinderProps> = ({ bindRef, setNodes }) => {
  const { getNodes, getIntersectingNodes } = useReactFlow();

  const onNodeDragStop = useCallback(
    (_: ReactMouseEvent, node: Node) => {
      const allNodes = getNodes();
      const selectedNodes = allNodes.filter((n) => n.selected);
      const nodesToProcess =
        selectedNodes.length > 0 && selectedNodes.some((n) => n.id === node.id) ? selectedNodes : [node];

      setNodes((prev) => {
        const next = prev.map((n) => ({ ...n }));
        const byId = new Map(next.map((n) => [n.id, n]));

        for (const raw of nodesToProcess) {
          const cur = byId.get(raw.id);
          if (!cur) continue;

          const parent = cur.parentId ? byId.get(cur.parentId) : null;
          const intersectingNodes = getIntersectingNodes(cur);
          const intersectionIds = new Set(intersectingNodes.map((n) => n.id));

          if (parent && parent.type === 'group') {
            if (!intersectionIds.has(parent.id)) {
              const bounds = getGroupBounds(parent);
              if (bounds) {
                cur.parentId = undefined;
                delete (cur as Node & { parentNode?: string }).parentNode;
                cur.position = {
                  x: bounds.left + cur.position.x,
                  y: bounds.top + cur.position.y,
                };
              }
            }
            continue;
          }

          if (!cur.parentId && cur.type !== 'group') {
            const candidateGroups = intersectingNodes.filter((n) => n.type === 'group');
            for (const group of candidateGroups) {
              const bounds = getGroupBounds(group);
              if (bounds) {
                cur.parentId = group.id;
                (cur as Node & { parentNode?: string }).parentNode = group.id;
                cur.position = {
                  x: cur.position.x - bounds.left,
                  y: cur.position.y - bounds.top,
                };
              }
              break;
            }
          }
        }

        return next;
      });
    },
    [getIntersectingNodes, getNodes, setNodes],
  );

  useLayoutEffect(() => {
    bindRef.current = onNodeDragStop;
    return () => {
      bindRef.current = null;
    };
  }, [bindRef, onNodeDragStop]);

  return null;
};

export default memo(NodeDragStopBinder);
