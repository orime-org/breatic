import { useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, type Node, type Edge } from '@xyflow/react';
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import { nanoid } from 'nanoid';
import copy from 'copy-to-clipboard';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import {
  getLockedGroupIds,
  isNodeLocked,
  isNodeLockable,
} from '@/spaces/canvas/common/lock-helpers';
import Divider from '@/ui/divider';
import { Icon } from '@/ui/icon';
import nodeIconMap from '@/pages/project/constants/nodeIconMap';

const groupPadding = 40;
/* PR9-A: hex literal kept intentionally — value is stored in node `data.backgroundColor` and parsed
   by `toRgba08` in GroupNode, which expects hex digits. Don't replace with a theme token. */
const defaultGroupBackgroundColor = '#35C838';

const ASSET_HANDLES: Record<
  string,
  { source?: { handleType: string; number: number }[]; target?: { handleType: string; number: number }[] }
> = {
  '1001': { target: [{ handleType: 'Text', number: 0 }] },
  '1002': { target: [{ handleType: 'Image', number: 0 }] },
  '1003': { target: [{ handleType: 'Video', number: 0 }] },
  '1004': { target: [{ handleType: 'Audio', number: 0 }] },
};

const generateNodeId = (nodeType: string): string => {
  return `${nodeType}-${Date.now()}-${nanoid(5)}`;
};

const copyToClipboard = (nodes: Node[], edges: Edge[]) => {
  const data = {
    nodes: nodes.map((n) => ({ ...n, selected: false })),
    edges: edges.map((e) => ({ ...e, selected: false })),
  };
  copy(JSON.stringify(data));
};

const readFromClipboard = async (): Promise<{ nodes: Node[]; edges: Edge[] } | null> => {
  try {
    const data = await navigator.clipboard.readText();
    if (!data) return null;
    return JSON.parse(data);
  } catch {
    return null;
  }
};

const pasteOffset = { x: 50, y: 50 };
const duplicateOffset = { x: 30, y: 30 };

export interface NodeContextMenuProps {
  open: boolean;
  /** Menu position: screen coordinates */
  left: number;
  top: number;
  /** Node id at right-click point; null means click on blank canvas (shows add node / undo / redo / paste) */
  contextNodeId: string | null;
  /** Screen coordinates at right-click, used to convert to canvas coordinates when pasting */
  clientX: number;
  clientY: number;
  onClose: () => void;
  /** For canvas menu: undo, redo */
  yjsUndo?: () => void;
  yjsRedo?: () => void;
  yjsCanUndo?: boolean;
  yjsCanRedo?: boolean;
}

const NodeContextMenu: React.FC<NodeContextMenuProps> = ({
  open,
  left,
  top,
  contextNodeId,
  clientX,
  clientY,
  onClose,
  yjsUndo,
  yjsRedo,
  yjsCanUndo = false,
  yjsCanRedo = false,
}) => {
  const [clipboardHasData, setClipboardHasData] = useState(false);
  const virtualRef = useRef({
    getBoundingClientRect: (): DOMRect => new DOMRect(left, top, 0, 0),
  });

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (nextOpen) => {
      if (!nextOpen) onClose();
    },
    placement: 'right-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(2), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  const dismiss = useDismiss(context, { outsidePress: true });
  const { getFloatingProps } = useInteractions([dismiss]);

  useEffect(() => {
    virtualRef.current.getBoundingClientRect = () => new DOMRect(left, top, 0, 0);
    refs.setReference(virtualRef.current);
  }, [open, left, top, refs]);

  const { getNodes, getEdges, getNodesBounds, screenToFlowPosition } = useReactFlow();
  const { nodes } = useCanvasData();
  const { onNodesChange, onEdgesChange, addNode, onConnect, setNodes, updateNode } = useCanvasActions();

  const selectedNodes = getNodes().filter((n) => n.selected);
  const groupSelection = useMemo(() => {
    const n = selectedNodes.length;
    if (n >= 2 && selectedNodes.every((node) => node.type !== 'group')) return { canGroup: true, isGroup: false };
    if (n === 1 && selectedNodes[0].type === 'group') return { canGroup: false, isGroup: true };
    return { canGroup: false, isGroup: false };
  }, [selectedNodes]);

  // Detect whether the clipboard has pasteable node data
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    readFromClipboard().then((data) => {
      if (!cancelled && data?.nodes?.length) setClipboardHasData(true);
    });
    return () => {
      cancelled = true;
      setClipboardHasData(false);
    };
  }, [open]);

  const getTargetNodesForAction = (): Node[] => {
    const nodes = getNodes();
    const selected = nodes.filter((n) => n.selected);
    if (contextNodeId) {
      const ctxNode = nodes.find((n) => n.id === contextNodeId);
      if (ctxNode && selected.some((n) => n.id === contextNodeId)) return selected;
      if (ctxNode) return [ctxNode];
    }
    return selected;
  };

  const handleCopy = () => {
    const targetNodes = getTargetNodesForAction();
    if (targetNodes.length === 0) return;

    const allNodes = getNodes();

    // When copying, if group nodes are included, also bring all their children (including nested) along
    const nodesMap = new Map<string, Node>();
    targetNodes.forEach((n) => nodesMap.set(n.id, n));

    type AnyNode = Node & { parentId?: string };

    let changed = true;
    while (changed) {
      changed = false;
      allNodes.forEach((node) => {
        const n = node as AnyNode;
        if (!n.parentId) return;
        if (!nodesMap.has(n.parentId)) return;
        if (nodesMap.has(n.id)) return;
        nodesMap.set(n.id, node);
        changed = true;
      });
    }

    const nodes = Array.from(nodesMap.values());

    const currentEdges = getEdges();
    const ids = new Set(nodes.map((n) => n.id));
    const edges = currentEdges.filter((e) => ids.has(e.source) && ids.has(e.target));
    copyToClipboard(nodes, edges);
    onClose();
  };

  const handleCut = () => {
    handleCopy();
    handleDelete();
  };

  const handlePaste = async () => {
    const data = await readFromClipboard();
    if (!data?.nodes?.length) return;
    const position = screenToFlowPosition({ x: clientX, y: clientY });
    const nodeIdMap = new Map<string, string>();

    // The data here may include group nodes and their children; child node positions are local coordinates relative to the parent group's top-left.
    // Goals:
    // 1) Overall behavior consistent with “non-group paste” (translate anchor to click position as a whole);
    // 2) If group nodes are also copied, inner children still compute local coordinates based on the current group's position and won't escape the group area.

    type PastedNode = Node & {
      parentId?: string;
      parentNode?: string;
    };

    const pastedNodes = data.nodes as PastedNode[];

    // Assign new ids to all old ids first
    pastedNodes.forEach((node) => {
      nodeIdMap.set(node.id, generateNodeId(String(node.type || 'node')));
    });

    const nodeMap = new Map<string, PastedNode>();
    pastedNodes.forEach((n) => nodeMap.set(n.id, n));

    // Calculate “original absolute coordinates” (position in canvas at time of copy), considering only top-level groups:
    // - Nodes without parentId: position is absolute (including group nodes)
    // - Nodes with parentId whose parent is a group:
    //   absolute = parent group top-left + child node local position
    const getOriginalAbs = (node: PastedNode): { x: number; y: number } => {
      const rawParentId = node.parentId ?? node.parentNode;
      if (!rawParentId) {
        return { x: node.position.x, y: node.position.y };
      }
      const parent = nodeMap.get(rawParentId);
      if (!parent || parent.type !== 'group') {
        // Parent not in the copy set or not a group, fall back to treating position as absolute
        return { x: node.position.x, y: node.position.y };
      }

      const style = (parent.style ?? {}) as { width?: number; height?: number };
      const w = Number(style.width) || 0;
      const h = Number(style.height) || 0;
      if (!w || !h) {
        return { x: node.position.x, y: node.position.y };
      }

      // Parent group position is the top-left corner
      const parentLeft = parent.position.x;
      const parentTop = parent.position.y;
      return {
        x: parentLeft + node.position.x,
        y: parentTop + node.position.y,
      };
    };

    const originalAbsById = new Map<string, { x: number; y: number }>();
    pastedNodes.forEach((n) => {
      originalAbsById.set(n.id, getOriginalAbs(n));
    });

    // Choose anchor node: prefer top-level group, then any group, finally fall back to the first node
    const anchorNode = (() => {
      const topLevelGroup = pastedNodes.find((n) => n.type === 'group' && !n.parentId && !n.parentNode);
      if (topLevelGroup) return topLevelGroup;
      const anyGroup = pastedNodes.find((n) => n.type === 'group');
      if (anyGroup) return anyGroup;
      return pastedNodes[0];
    })();

    const firstAbs = originalAbsById.get(anchorNode.id)!;

    // Overall translation delta (consistent with original non-group paste logic)
    const delta = {
      x: position.x - firstAbs.x + pasteOffset.x,
      y: position.y - firstAbs.y + pasteOffset.y,
    };

    // Calculate target absolute coordinates after pasting for each node
    const newAbsByOldId = new Map<string, { x: number; y: number }>();
    pastedNodes.forEach((n) => {
      const orig = originalAbsById.get(n.id)!;
      newAbsByOldId.set(n.id, { x: orig.x + delta.x, y: orig.y + delta.y });
    });

    const oldIds = new Set(pastedNodes.map((n) => n.id));

    const newNodes: Node[] = pastedNodes.map((node) => {
      const oldId = node.id;
      const newId = nodeIdMap.get(oldId)!;
      const targetAbs = newAbsByOldId.get(oldId)!;

      const rawParentId = node.parentId ?? node.parentNode;
      let nextParentId: string | undefined;
      let positionForFlow = { x: targetAbs.x, y: targetAbs.y };

      // If the parent is also part of this copy-paste and is a group, preserve the group structure:
      // 1) Map parent id to the new parent id;
      // 2) Use local coordinates relative to the new parent group's top-left for position (group position is top-left)
      if (rawParentId && oldIds.has(rawParentId)) {
        const parentOld = nodeMap.get(rawParentId);
        const parentNewId = nodeIdMap.get(rawParentId);
        const parentAbs = newAbsByOldId.get(rawParentId);
        if (parentOld && parentNewId && parentAbs && parentOld.type === 'group') {
          nextParentId = parentNewId;
          const parentLeft = parentAbs.x;
          const parentTop = parentAbs.y;
          positionForFlow = {
            x: targetAbs.x - parentLeft,
            y: targetAbs.y - parentTop,
          };
        }
      }

      const clonedData = node.data ? structuredClone(node.data) : {};

      const result: PastedNode = {
        ...node,
        id: newId,
        position: positionForFlow,
        data: clonedData,
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

    // Raise overall z-index of pasted nodes above the current canvas maximum, consistent with "duplicate" behavior
    const allNodesBeforePaste = getNodes();
    const maxZIndex = allNodesBeforePaste.reduce((max, node) => {
      const zIndex = (node as Node & { zIndex?: number }).zIndex ?? 0;
      return Math.max(max, zIndex);
    }, 0);
    const pasteBaseZIndex = maxZIndex + 1;
    newNodes.forEach((n) => {
      (n as Node & { zIndex?: number }).zIndex = pasteBaseZIndex;
    });

    // Whether this is a “group paste”: if group nodes are included, only select group nodes after pasting, not inner children
    const hasGroupInPaste = newNodes.some((n) => n.type === 'group');
    if (hasGroupInPaste) {
      newNodes.forEach((n) => {
        (n as Node & { selected?: boolean }).selected = n.type === 'group';
      });
    } else {
      newNodes.forEach((n) => {
        (n as Node & { selected?: boolean }).selected = true;
      });
    }

    const newEdges: Edge[] = data.edges
      .map((edge) => {
        const src = nodeIdMap.get(edge.source);
        const tgt = nodeIdMap.get(edge.target);
        if (!src || !tgt) return null;
        return { ...edge, id: `edge-${nanoid()}`, source: src, target: tgt } as Edge;
      })
      .filter((e): e is Edge => e !== null);

    const allNodes = getNodes();
    onNodesChange(allNodes.map((n) => ({ type: 'select' as const, id: n.id, selected: false })));
    // Add all first with select: false, to avoid addNode clearing selection each time so only the last node's select takes effect
    newNodes.forEach((n) => addNode(n, { select: false }));
    newEdges.forEach((e) =>
      onConnect({
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? null,
        targetHandle: e.targetHandle ?? null,
      }),
    );
    // Then set selection uniformly: group paste selects only groups, otherwise select all
    if (hasGroupInPaste) {
      onNodesChange(
        newNodes.filter((n) => n.type === 'group').map((n) => ({ type: 'select' as const, id: n.id, selected: true })),
      );
    } else {
      onNodesChange(newNodes.map((n) => ({ type: 'select' as const, id: n.id, selected: true })));
    }
    onClose();
  };

  const handleDuplicate = () => {
    const targetNodes = getTargetNodesForAction();
    if (targetNodes.length === 0) return;

    const allNodes = getNodes();

    // If group nodes are selected, include all their children (including nested) as part of the “duplicate”
    const nodesMap = new Map<string, Node>();
    targetNodes.forEach((n) => nodesMap.set(n.id, n));

    type AnyNode = Node & { parentId?: string };

    let changed = true;
    while (changed) {
      changed = false;
      allNodes.forEach((node) => {
        const n = node as AnyNode;
        if (!n.parentId) return;
        if (!nodesMap.has(n.parentId)) return;
        if (nodesMap.has(n.id)) return;
        nodesMap.set(n.id, node);
        changed = true;
      });
    }

    const nodes = Array.from(nodesMap.values());

    const currentEdges = getEdges();
    const ids = new Set(nodes.map((n) => n.id));
    const edges = currentEdges.filter((e) => ids.has(e.source) && ids.has(e.target));

    const nodeIdMap = new Map<string, string>();
    nodes.forEach((node) => nodeIdMap.set(node.id, generateNodeId(String(node.type || 'node'))));

    type GroupNodeLike = Node & { parentId?: string; parentNode?: string; style?: { width?: number; height?: number } };
    const nodeById = new Map<string, GroupNodeLike>();
    (nodes as GroupNodeLike[]).forEach((n) => nodeById.set(n.id, n));
    const allNodesById = new Map<string, GroupNodeLike>();
    allNodes.forEach((n) => allNodesById.set(n.id, n as GroupNodeLike));

    const nodeIdSet = new Set(nodes.map((n) => n.id));

    // Raise overall z-index of duplicates above the current canvas maximum
    const maxZIndex = allNodes.reduce((max, node) => {
      const zIndex = (node as Node & { zIndex?: number }).zIndex ?? 0;
      return Math.max(max, zIndex);
    }, 0);
    const duplicateBaseZIndex = maxZIndex + 1;

    const newNodes: Node[] = (nodes as GroupNodeLike[]).map((node) => {
      const oldId = node.id;
      const newId = nodeIdMap.get(oldId)!;

      const rawParentId = node.parentId ?? node.parentNode;
      let nextParentId: string | undefined;

      // Default: treat position as canvas coordinates and apply overall offset (for non-group nodes, or nodes that left their group)
      let newPosition = {
        x: node.position.x + duplicateOffset.x,
        y: node.position.y + duplicateOffset.y,
      };

      // If parent is also in the current duplicate set and is a group, keep local coordinates unchanged, only move the group
      if (rawParentId && nodeIdSet.has(rawParentId)) {
        const parent = nodeById.get(rawParentId);
        if (parent && parent.type === 'group') {
          const parentNewId = nodeIdMap.get(rawParentId);
          if (parentNewId) {
            nextParentId = parentNewId;
            // Child node position is local coordinates relative to parent group's top-left; no offset added here
            newPosition = { ...node.position };
          }
        }
      } else if (rawParentId) {
        // Duplicating a single node inside a group: parent not in duplicate set, convert relative coords to canvas absolute coords then apply offset
        const parent = allNodesById.get(rawParentId);
        if (parent && parent.type === 'group') {
          const style = (parent.style ?? {}) as { width?: number; height?: number };
          const w = Number(style.width) || 0;
          const h = Number(style.height) || 0;
          if (w && h) {
            const parentLeft = parent.position.x;
            const parentTop = parent.position.y;
            const absX = parentLeft + node.position.x;
            const absY = parentTop + node.position.y;
            newPosition = {
              x: absX + duplicateOffset.x,
              y: absY + duplicateOffset.y,
            };
          }
        }
      }

      const clonedData = node.data ? structuredClone(node.data) : {};

      const result: GroupNodeLike & { zIndex?: number } = {
        ...node,
        id: newId,
        position: newPosition,
        selected: true,
        data: clonedData,
        zIndex: duplicateBaseZIndex,
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
    const newEdges: Edge[] = edges
      .map((e) => {
        const src = nodeIdMap.get(e.source);
        const tgt = nodeIdMap.get(e.target);
        if (!src || !tgt) return null;
        return { ...e, id: `edge-${nanoid()}`, source: src, target: tgt } as Edge;
      })
      .filter((e): e is Edge => e !== null);

    onNodesChange(allNodes.map((n) => ({ type: 'select' as const, id: n.id, selected: false })));
    newNodes.forEach((n) => addNode(n, { select: false }));
    newEdges.forEach((e) =>
      onConnect({
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? null,
        targetHandle: e.targetHandle ?? null,
      }),
    );
    // Consistent with paste: when duplicate includes groups, select only groups, not inner nodes
    const hasGroupInDuplicate = newNodes.some((n) => n.type === 'group');
    if (hasGroupInDuplicate) {
      onNodesChange(
        newNodes.filter((n) => n.type === 'group').map((n) => ({ type: 'select' as const, id: n.id, selected: true })),
      );
    } else {
      onNodesChange(newNodes.map((n) => ({ type: 'select' as const, id: n.id, selected: true })));
    }
    onClose();
  };

  const handleGroup = () => {
    if (!groupSelection.canGroup || selectedNodes.length < 2) return;
    const allNodes = getNodes();
    const selectedIds = new Set(selectedNodes.map((n) => n.id));
    const bounds = getNodesBounds(selectedNodes);
    const groupId = `group-${nanoid(8)}`;
    const containerLeft = bounds.x - groupPadding;
    const containerTop = bounds.y - groupPadding;
    const containerWidth = bounds.width + groupPadding * 2;
    const containerHeight = bounds.height + groupPadding * 2;
    const groupNode: Node = {
      id: groupId,
      type: 'group',
      position: { x: containerLeft, y: containerTop },
      style: { width: containerWidth, height: containerHeight, border: 0, boxShadow: 'none' },
      data: { collapsed: false, backgroundColor: defaultGroupBackgroundColor },
      selected: true,
    };
    const childNodes = selectedNodes.map((n) => ({
      ...n,
      parentId: groupId,
      position: { x: n.position.x - containerLeft, y: n.position.y - containerTop },
      selected: false,
    }));
    const restNodes = allNodes.filter((n) => !selectedIds.has(n.id)).map((n) => ({ ...n, selected: false }));
    setNodes([groupNode, ...childNodes, ...restNodes]);
    onClose();
  };

  const handleUngroup = () => {
    if (!groupSelection.isGroup || selectedNodes.length !== 1) return;
    const group = selectedNodes[0];
    if (group.type !== 'group') return;
    const allNodes = getNodes();
    const containerLeft = group.position.x;
    const containerTop = group.position.y;
    const newNodes = allNodes
      .filter((n) => n.id !== group.id)
      .map((n) => {
        if (n.parentId !== group.id) return { ...n, selected: false };
        const { parentId, extent, ...rest } = n;
        void parentId;
        void extent;
        return {
          ...rest,
          position: { x: n.position.x + containerLeft, y: n.position.y + containerTop },
          selected: false,
        };
      });
    setNodes(newNodes);
    onClose();
  };

  /** Add an asset node of the specified type at the right-click position (consistent with paste: converts clientX/clientY to canvas coordinates) */
  const addNodeAtPosition = (type: string) => {
    const nodeCenterTarget = screenToFlowPosition({
      x: clientX,
      y: clientY,
    });
    const maxZIndex = nodes.reduce((max, node) => {
      const zIndex = (node as Node & { zIndex?: number }).zIndex ?? 0;
      return Math.max(max, zIndex);
    }, 0);
    const newNodeId = generateNodeId(type);
    const newNode: Node & { zIndex?: number } = {
      id: newNodeId,
      type,
      position: nodeCenterTarget,
      selected: true,
      zIndex: maxZIndex + 1,
      data: { handles: ASSET_HANDLES[type] ?? {} },
    };
    addNode(newNode, { select: true });
    onClose();
  };

  const handleDelete = () => {
    const targetNodes = getTargetNodesForAction();
    if (targetNodes.length === 0) return;
    const allNodes = getNodes();
    const currentEdges = getEdges();
    // F9 — defensive filter: skip any target that's locked even if
    // the caller forgot to gate. The menu UX disables Delete when
    // any target is locked, but Cut (which delegates here) also
    // depends on this guard for "delete the unlocked items only,
    // keep locked ones in place".
    const lockedGroupIdsForDelete = getLockedGroupIds(allNodes);
    const deletableTargets = targetNodes.filter(
      (n) => !isNodeLocked(n, lockedGroupIdsForDelete),
    );
    if (deletableTargets.length === 0) {
      onClose();
      return;
    }
    const nodeIdsToRemove = new Set<string>(deletableTargets.map((n) => n.id));
    deletableTargets.forEach((n) => {
      if (n.type === 'group') {
        allNodes.forEach((node) => {
          if (node.parentId === n.id) nodeIdsToRemove.add(node.id);
        });
      }
    });
    const edgesToRemove = currentEdges.filter(
      (e) => nodeIdsToRemove.has(e.source) || nodeIdsToRemove.has(e.target) || e.selected,
    );
    onNodesChange(Array.from(nodeIdsToRemove).map((id) => ({ type: 'remove' as const, id })));
    onEdgesChange(edgesToRemove.map((e) => ({ type: 'remove' as const, id: e.id })));
    onClose();
  };

  const isPaneMenu = contextNodeId === null;
  const showNodeActions = contextNodeId !== null || getTargetNodesForAction().length > 0;

  // F9 — lock state for the menu's lock-toggle item + delete-gating.
  // Computed once per render; the action handlers call
  // `getTargetNodesForAction()` again at click time so post-render
  // selection changes are still reflected accurately (cheap).
  const lockTargetSnapshot = getTargetNodesForAction();
  const allNodesNow = getNodes();
  const lockedGroupIdsNow = useMemo(() => getLockedGroupIds(allNodesNow), [allNodesNow]);
  const targetsLockedNow = lockTargetSnapshot.some((n) => isNodeLocked(n, lockedGroupIdsNow));
  const targetsAllLockable = lockTargetSnapshot.every(isNodeLockable);
  const lockableTargetsCount = lockTargetSnapshot.filter(isNodeLockable).length;
  const showLockToggle = lockableTargetsCount > 0 && targetsAllLockable;
  // Mixed selection (some locked + some unlocked) defaults to "Lock"
  // — clicking flips every target to locked, which feels like the
  // less-destructive default of the two.
  const lockToggleLabel = targetsLockedNow ? 'Unlock' : 'Lock';

  const handleToggleLock = () => {
    const targets = getTargetNodesForAction().filter(isNodeLockable);
    if (targets.length === 0) return;
    // Same direction for all targets in one action — avoids the
    // confusing "some flipped, some didn't" outcome when applying
    // to a mixed selection.
    const nextLocked = !targets.every((n) =>
      isNodeLocked(n, lockedGroupIdsNow),
    );
    targets.forEach((n) => {
      updateNode(n.id, { data: { locked: nextLocked } });
    });
    onClose();
  };

  const itemBase =
    'flex w-full min-h-8 items-center justify-between gap-3 rounded-[4px] px-2 py-[4px] text-xs text-text-default-base';
  const itemInteractive = 'cursor-pointer hover:bg-background-default-secondary';
  const itemDisabled = 'opacity-50 cursor-not-allowed';

  const shortcutClass = 'text-content-tertiary shrink-0';

  // Menu item: has type: 'divider' for divider, otherwise a regular row (key, label, shortcut, disabled, onClick, icon)
  type MenuItemRow = {
    key: string;
    label: string;
    shortcut: string | null;
    disabled: boolean;
    onClick: () => void;
    icon?: string;
  };
  type MenuItem = MenuItemRow | { type: 'divider' };

  const paneMenuItems: MenuItem[] = [
    {
      key: 'paste',
      label: 'Paste',
      shortcut: 'Ctrl + v',
      disabled: !clipboardHasData,
      onClick: () => clipboardHasData && handlePaste(),
      icon: 'workspace-content-copy',
    },
    {
      key: 'undo',
      label: 'Undo',
      shortcut: 'Ctrl + z',
      disabled: !yjsCanUndo,
      onClick: () => {
        yjsUndo?.();
        onClose();
      },
      icon: 'project-redo-icon',
    },
    {
      key: 'redo',
      label: 'Redo',
      shortcut: 'Shift + Ctrl + z',
      disabled: !yjsCanRedo,
      onClick: () => {
        yjsRedo?.();
        onClose();
      },
      icon: 'project-undo-icon',
    },
    { type: 'divider' },
    {
      key: 'addText',
      label: 'Add Text Node',
      shortcut: null,
      disabled: false,
      onClick: () => addNodeAtPosition('1001'),
      icon: nodeIconMap['1001'],
    },
    {
      key: 'addImage',
      label: 'Add Image Node',
      shortcut: null,
      disabled: false,
      onClick: () => addNodeAtPosition('1002'),
      icon: nodeIconMap['1002'],
    },
    {
      key: 'addAudio',
      label: 'Add Audio Node',
      shortcut: null,
      disabled: false,
      onClick: () => addNodeAtPosition('1004'),
      icon: nodeIconMap['1004'],
    },
    {
      key: 'addVideo',
      label: 'Add Video Node',
      shortcut: null,
      disabled: false,
      onClick: () => addNodeAtPosition('1003'),
      icon: nodeIconMap['1003'],
    },
  ];

  const nodeMenuItems: MenuItem[] = [
    {
      key: 'copy',
      label: 'Copy',
      shortcut: 'Ctrl + c',
      disabled: !showNodeActions,
      onClick: () => showNodeActions && handleCopy(),
      icon: 'project-copy-icon',
    },
    {
      key: 'cut',
      label: 'Cut',
      shortcut: 'Ctrl + x',
      // Cut = copy + delete; delete-on-locked is a no-op in the
      // handler, but the menu UX gates Cut so users see the lock is
      // protecting their content rather than getting a silent partial.
      disabled: !showNodeActions || targetsLockedNow,
      onClick: () => showNodeActions && !targetsLockedNow && handleCut(),
      icon: 'project-cut-icon',
    },
    {
      key: 'duplicate',
      label: 'Duplicate',
      shortcut: null,
      disabled: !showNodeActions,
      onClick: () => showNodeActions && handleDuplicate(),
      icon: 'project-duplicate-icon',
    },
    {
      key: 'collectAssets',
      label: 'Collect Assets',
      shortcut: null,
      disabled: true,
      onClick: () => {},
      icon: 'project-collect-assets-icon',
    },
    {
      key: 'group',
      label: 'Group',
      shortcut: 'Ctrl + g',
      disabled: !groupSelection.canGroup,
      onClick: () => groupSelection.canGroup && handleGroup(),
      icon: 'project-group-icon',
    },
    {
      key: 'ungroup',
      label: 'Ungroup',
      shortcut: 'Ctrl + shift + g',
      disabled: !groupSelection.isGroup,
      onClick: () => groupSelection.isGroup && handleUngroup(),
      icon: 'project-ungroup-icon',
    },
    { type: 'divider' },
    // Lock toggle — hidden for non-lockable types (annotation per
    // spec §10.13.6). When the mixed-target case kicks in, clicking
    // applies the same direction to every target (see
    // `handleToggleLock`).
    ...(showLockToggle
      ? ([
          {
            key: 'lock',
            label: lockToggleLabel,
            shortcut: null,
            disabled: false,
            onClick: handleToggleLock,
            icon: targetsLockedNow ? 'project-unlock-icon' : 'project-lock-icon',
          } as MenuItemRow,
        ] as const)
      : ([] as const)),
    {
      key: 'delete',
      // F9 — locked nodes block accidental delete. The user has to
      // unlock first; the menu makes this obvious by greying out
      // Delete and the unlock toggle sits one row above.
      label: 'Delete',
      shortcut: 'backspace/del',
      disabled: !showNodeActions || targetsLockedNow,
      onClick: () => showNodeActions && !targetsLockedNow && handleDelete(),
      icon: 'project-delete-icon',
    },
  ];

  const menuItems = isPaneMenu ? paneMenuItems : nodeMenuItems;

  if (!open) return null;

  const menuContent = (
    <div
      ref={refs.setFloating}
      style={floatingStyles}
      className='z-[1000] min-w-[200px] overflow-hidden rounded-[8px] bg-[var(--color-background-default-base)] p-2 shadow-lg flex flex-col gap-1'
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      {...getFloatingProps()}
    >
      {menuItems.map((item, index) =>
        (item as { type?: string }).type === 'divider' ? (
          <Divider key={`menu-divider-${index}`} type='horizontal' className='my-1' />
        ) : (
          (() => {
            const row = item as MenuItemRow;
            return (
              <div
                key={row.key}
                role='button'
                tabIndex={row.disabled ? -1 : 0}
                className={`${itemBase} ${row.disabled ? itemDisabled : itemInteractive}`}
                onClick={row.disabled ? undefined : row.onClick}
              >
                <div
                  className={`flex items-center justify-between gap-3 min-w-0 flex-1 ${row.disabled ? 'pointer-events-none' : ''}`}
                >
                  <div className='flex items-center gap-2 min-w-0'>
                    {row.icon && (
                      <Icon
                        name={row.icon}
                        width={16}
                        height={16}
                        color={row.disabled ? 'var(--color-content-tertiary)' : 'var(--color-icon-secondary)'}
                        className='shrink-0'
                      />
                    )}
                    <span>{row.label}</span>
                  </div>
                  {row.shortcut != null && <span className={shortcutClass}>{row.shortcut}</span>}
                </div>
              </div>
            );
          })()
        ),
      )}
    </div>
  );

  return <FloatingPortal>{menuContent}</FloatingPortal>;
};

export default NodeContextMenu;
