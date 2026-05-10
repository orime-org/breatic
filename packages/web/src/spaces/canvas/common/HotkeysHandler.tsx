import { useRef, useEffect, useCallback, type RefObject } from 'react';
import { useReactFlow, type Node, type Edge } from '@xyflow/react';
import KeyController, { type KeyControllerEvent } from 'keycon';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import {
  getLockedGroupIds,
  isNodeLocked,
} from '@/spaces/canvas/common/lock-helpers';
import { nanoid } from 'nanoid';

/** Builds a new unique node id from type prefix, timestamp, and random suffix. */
const generateNodeId = (nodeType: string): string => {
  const timestamp = Date.now();
  const randomString = nanoid(5);
  return `${nodeType}-${timestamp}-${randomString}`;
};

/** Persists serialized nodes and edges to localStorage (in-canvas clipboard). */
const copyToClipboard = (nodes: Node[], edges: Edge[]) => {
  const data = {
    nodes: nodes.map((node) => ({
      ...node,
      selected: false,
    })),
    edges: edges.map((edge) => ({
      ...edge,
      selected: false,
    })),
  };
  localStorage.setItem('canvas_clipboard', JSON.stringify(data));
};

/** Reads serialized nodes and edges from localStorage, or null if missing/invalid. */
const readFromClipboard = (): { nodes: Node[]; edges: Edge[] } | null => {
  const data = localStorage.getItem('canvas_clipboard');
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};

/** Nudge applied to pasted nodes in flow coordinates. */
const pasteOffset = { x: 50, y: 50 };

const isInputElement = (target: EventTarget | null): boolean => {
  if (!target) return false;
  const el = target as HTMLElement;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
};

type AnyNode = Node & {
  parentId?: string;
  parentNode?: string;
  style?: { width?: number; height?: number };
  zIndex?: number;
};

// `getLockedGroupIds` and `isNodeLocked` now live in
// `@/spaces/canvas/common/lock-helpers` so the v13 lock predicate
// (any node with `data.locked === true`, plus locked-group
// descendants) stays in lock-step across HotkeysHandler,
// NodeContextMenu, and ProjectCanvasContent.

interface HotkeysHandlerProps {
  /** Yjs undo handler */
  yjsUndo?: () => void;
  yjsRedo?: () => void;
  yjsCanUndo?: boolean;
  yjsCanRedo?: boolean;
  /** When true, all keyboard shortcuts are suppressed. */
  disabled?: boolean;
}

/**
 * Canvas keyboard shortcuts: copy/paste selection (with groups), delete, undo/redo via Yjs when provided.
 */
const HotkeysHandler: React.FC<HotkeysHandlerProps> = ({
  yjsUndo,
  yjsRedo,
  yjsCanUndo = false,
  yjsCanRedo = false,
  disabled = false,
}) => {
  const { getNodes, getEdges } = useReactFlow();
  const { onNodesChange, onEdgesChange, addNode, onConnect } = useCanvasActions();
  const disabledRef: RefObject<boolean> = useRef(disabled);
  disabledRef.current = disabled;
  /** In-memory clipboard: serialized nodes and edges from the last copy. */
  const clipboardDataRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null);

  const handleCopy = useCallback(
    (e: KeyboardEvent) => {
      if (disabledRef.current) return;
      const target = e.target as HTMLElement;
      if (!target || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      const currentNodes = getNodes() as AnyNode[];
      const lockedGroupIds = getLockedGroupIds(currentNodes);
      const currentEdges = getEdges();

      const nodesMap = new Map<string, AnyNode>();
      currentNodes
        .filter((n) => n.selected)
        .forEach((n) => {
          if (!isNodeLocked(n as AnyNode, lockedGroupIds)) {
            nodesMap.set(n.id, n as AnyNode);
          }
        });

      let changed = true;
      while (changed) {
        changed = false;
        currentNodes.forEach((node) => {
          const n = node as AnyNode;
          const parentId = n.parentId ?? n.parentNode;
          if (!parentId) return;
          if (!nodesMap.has(parentId)) return;
          if (nodesMap.has(n.id)) return;
          nodesMap.set(n.id, n);
          changed = true;
        });
      }

      const nodesToCopy = Array.from(nodesMap.values());
      if (nodesToCopy.length === 0) return;

      const selectedNodeIds = new Set(nodesToCopy.map((n) => n.id));
      const selectedEdges = currentEdges.filter(
        (edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target)
      );

      copyToClipboard(nodesToCopy, selectedEdges);
      clipboardDataRef.current = {
        nodes: nodesToCopy.map((n) => ({ ...n, selected: false })),
        edges: selectedEdges.map((e) => ({ ...e, selected: false })),
      };

    },
    [getNodes, getEdges]
  );

  const handlePaste = useCallback(
    (e: KeyboardEvent) => {
      if (disabledRef.current) return;
      const target = e.target as HTMLElement;
      if (!target || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      const clipboardData = clipboardDataRef.current || readFromClipboard();
      if (!clipboardData || clipboardData.nodes.length === 0) return;

      type PastedNode = AnyNode;
      const pastedNodes = clipboardData.nodes as PastedNode[];

      const nodeIdMap = new Map<string, string>();
      pastedNodes.forEach((node) => {
        nodeIdMap.set(node.id, generateNodeId(String(node.type || 'node')));
      });

      const nodeMap = new Map<string, PastedNode>();
      pastedNodes.forEach((n) => nodeMap.set(n.id, n));

      const allNodesBeforePaste = getNodes() as AnyNode[];
      const allNodesById = new Map<string, AnyNode>();
      allNodesBeforePaste.forEach((n) => allNodesById.set(n.id, n));

      /**
       * Absolute position before paste offset:
       * - No parent: `position` is already absolute.
       * - Parent in clipboard and is group: parent top-left + child local `position`.
       * - Child-only copy: resolve parent group on canvas and add local offset.
       */
      const getOriginalAbs = (node: PastedNode): { x: number; y: number } => {
        const rawParentId = node.parentId ?? node.parentNode;
        if (!rawParentId) return { x: node.position.x, y: node.position.y };

        const parentInClipboard = nodeMap.get(rawParentId);
        if (parentInClipboard && parentInClipboard.type === 'group') {
          const style = (parentInClipboard.style ?? {}) as { width?: number; height?: number };
          const w = Number(style.width) || 0;
          const h = Number(style.height) || 0;
          if (w && h) {
            const parentLeft = parentInClipboard.position.x;
            const parentTop = parentInClipboard.position.y;
            return { x: parentLeft + node.position.x, y: parentTop + node.position.y };
          }
        }

        const parentInCanvas = allNodesById.get(rawParentId);
        if (parentInCanvas && parentInCanvas.type === 'group') {
          const style = (parentInCanvas.style ?? {}) as { width?: number; height?: number };
          const w = Number(style.width) || 0;
          const h = Number(style.height) || 0;
          if (w && h) {
            const parentLeft = parentInCanvas.position.x;
            const parentTop = parentInCanvas.position.y;
            const absX = parentLeft + node.position.x;
            const absY = parentTop + node.position.y;
            return { x: absX, y: absY };
          }
        }

        return { x: node.position.x, y: node.position.y };
      };

      const originalAbsById = new Map<string, { x: number; y: number }>();
      pastedNodes.forEach((n) => originalAbsById.set(n.id, getOriginalAbs(n)));

      const delta = { x: pasteOffset.x, y: pasteOffset.y };
      const newAbsByOldId = new Map<string, { x: number; y: number }>();
      pastedNodes.forEach((n) => {
        const orig = originalAbsById.get(n.id)!;
        newAbsByOldId.set(n.id, { x: orig.x + delta.x, y: orig.y + delta.y });
      });

      const oldIds = new Set(pastedNodes.map((n) => n.id));
      const maxZ = allNodesBeforePaste.reduce(
        (m, node) => Math.max(m, (node as AnyNode).zIndex ?? 0),
        0
      );

      const newNodes: Node[] = pastedNodes.map((node) => {
        const oldId = node.id;
        const newId = nodeIdMap.get(oldId)!;
        const targetAbs = newAbsByOldId.get(oldId)!;
        const rawParentId = node.parentId ?? node.parentNode;
        let nextParentId: string | undefined;
        let positionForFlow = { x: targetAbs.x, y: targetAbs.y };

        if (rawParentId && oldIds.has(rawParentId)) {
          const parentOld = nodeMap.get(rawParentId);
          const parentNewId = nodeIdMap.get(rawParentId);
          const parentAbs = newAbsByOldId.get(rawParentId);
          if (parentOld && parentNewId && parentAbs && parentOld.type === 'group') {
            nextParentId = parentNewId;
            const parentLeft = parentAbs.x;
            const parentTop = parentAbs.y;
            positionForFlow = { x: targetAbs.x - parentLeft, y: targetAbs.y - parentTop };
          }
        }

        const result: AnyNode = {
          ...(node as AnyNode),
          id: newId,
          position: positionForFlow,
          data: node.data ? structuredClone(node.data) : {},
          zIndex: maxZ + 1,
        };

        if (nextParentId) {
          result.parentId = nextParentId;
          result.parentNode = nextParentId;
        } else {
          delete result.parentId;
          delete result.parentNode;
        }

        return result as unknown as Node;
      });

      const hasGroupInPaste = newNodes.some((n) => n.type === 'group');
      newNodes.forEach((n) => {
        (n as AnyNode).selected = hasGroupInPaste ? n.type === 'group' : true;
      });

      const newEdges: Edge[] = (clipboardData.edges || [])
        .map((edge) => {
          const src = nodeIdMap.get(edge.source);
          const tgt = nodeIdMap.get(edge.target);
          if (!src || !tgt) return null;
          return {
            ...edge,
            id: `edge-${nanoid()}`,
            source: src,
            target: tgt,
          } as Edge;
        })
        .filter((e): e is Edge => e !== null);

      const allNodes = getNodes();
      onNodesChange(
        allNodes.map((node) => ({
          type: 'select' as const,
          id: node.id,
          selected: false,
        }))
      );

      newNodes.forEach((node) => {
        addNode(node, { select: false });
      });

      newEdges.forEach((edge) => {
        onConnect({
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle ?? null,
          targetHandle: edge.targetHandle ?? null,
        });
      });

      if (hasGroupInPaste) {
        onNodesChange(
          newNodes
            .filter((n) => n.type === 'group')
            .map((n) => ({ type: 'select' as const, id: n.id, selected: true }))
        );
      } else {
        onNodesChange(newNodes.map((n) => ({ type: 'select' as const, id: n.id, selected: true })));
      }
    },
    [getNodes, onNodesChange, addNode, onConnect]
  );

  const handleDelete = useCallback(
    (e: KeyboardEvent) => {
      if (disabledRef.current) return;
      const target = e.target as HTMLElement;
      if (!target || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      const currentNodes = getNodes() as AnyNode[];
      const currentEdges = getEdges();
      const lockedGroupIds = getLockedGroupIds(currentNodes);

      const nodeById = new Map<string, AnyNode>();
      currentNodes.forEach((n) => nodeById.set(n.id, n));

      const selectedNodes = currentNodes.filter(
        (n) => n.selected && !isNodeLocked(n as AnyNode, lockedGroupIds)
      );
      const selectedEdges = currentEdges.filter((edge) => {
        if (!edge.selected) return false;
        const sourceNode = nodeById.get(edge.source);
        const targetNode = nodeById.get(edge.target);
        if (sourceNode && isNodeLocked(sourceNode, lockedGroupIds)) return false;
        if (targetNode && isNodeLocked(targetNode, lockedGroupIds)) return false;
        return true;
      });

      const nodeIdsToRemove = new Set(selectedNodes.map((n) => n.id));
      selectedNodes.forEach((n) => {
        if (n.type === 'group') {
          currentNodes.forEach((node) => {
            const parentId = node.parentId ?? node.parentNode;
            if (parentId === n.id) nodeIdsToRemove.add(node.id);
          });
        }
      });

      if (nodeIdsToRemove.size > 0) {
        onNodesChange(Array.from(nodeIdsToRemove).map((id) => ({ type: 'remove' as const, id })));
      }
      if (selectedEdges.length > 0) {
        onEdgesChange(selectedEdges.map((edge) => ({ type: 'remove' as const, id: edge.id })));
      }
    },
    [getNodes, getEdges, onNodesChange, onEdgesChange]
  );

  useEffect(() => {
    const keycon = new KeyController(window);

    const checkInput = (e: KeyControllerEvent): boolean => {
      return isInputElement(e.inputEvent.target);
    };

    const copyHandler = (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      e.inputEvent.preventDefault();
      handleCopy(e.inputEvent as KeyboardEvent);
    };
    keycon.keydown(['ctrl', 'c'], copyHandler);
    keycon.keydown(['meta', 'c'], copyHandler);

    const pasteHandler = (e: KeyControllerEvent) => {
      if (checkInput(e)) return;
      const nodes = getNodes() as AnyNode[];
      const lockedGroupIds = getLockedGroupIds(nodes);
      const hasSelectedUnlockedNode = nodes.some(
        (n) => n.selected && !isNodeLocked(n, lockedGroupIds)
      );
      if (hasSelectedUnlockedNode) {
        e.inputEvent.preventDefault();
        handlePaste(e.inputEvent as KeyboardEvent);
      }
    };
    keycon.keydown(['ctrl', 'v'], pasteHandler);
    keycon.keydown(['meta', 'v'], pasteHandler);

    keycon.keydown('delete', (e: KeyControllerEvent) => {
      if (disabledRef.current) return;
      if (checkInput(e)) return;
      e.inputEvent.preventDefault();
      handleDelete(e.inputEvent as KeyboardEvent);
    });

    const undoHandler = (e: KeyControllerEvent) => {
      if (disabledRef.current) return;
      if (checkInput(e)) return;
      if (e.shiftKey) return;
      if (yjsCanUndo && yjsUndo) {
        e.inputEvent.preventDefault();
        yjsUndo();
      }
    };
    keycon.keydown(['ctrl', 'z'], undoHandler);
    keycon.keydown(['meta', 'z'], undoHandler);

    const redoHandler1 = (e: KeyControllerEvent) => {
      if (disabledRef.current) return;
      if (checkInput(e)) return;
      if (yjsCanRedo && yjsRedo) {
        e.inputEvent.preventDefault();
        yjsRedo();
      }
    };
    keycon.keydown(['ctrl', 'y'], redoHandler1);
    keycon.keydown(['meta', 'y'], redoHandler1);

    const redoHandler2 = (e: KeyControllerEvent) => {
      if (disabledRef.current) return;
      if (checkInput(e)) return;
      if (yjsCanRedo && yjsRedo) {
        e.inputEvent.preventDefault();
        yjsRedo();
      }
    };
    keycon.keydown(['ctrl', 'shift', 'z'], redoHandler2);
    keycon.keydown(['meta', 'shift', 'z'], redoHandler2);

    return () => {
      keycon.destroy();
    };
  }, [handleCopy, handlePaste, handleDelete, yjsCanUndo, yjsCanRedo, yjsUndo, yjsRedo, getNodes]);

  return null;
};

export default HotkeysHandler;

