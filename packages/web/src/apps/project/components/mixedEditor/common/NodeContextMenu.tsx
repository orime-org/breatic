import { useEffect, useRef, useState, type FC } from 'react';
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
import { useMixedEditorStore } from '@/hooks/useMixedEditorStore';
import Divider from '@/components/base/divider';
import { Icon } from '@/components/base/icon';

const pasteOffset = { x: 50, y: 50 };
const duplicateOffset = { x: 30, y: 30 };

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
    return JSON.parse(data) as { nodes: Node[]; edges: Edge[] };
  } catch {
    return null;
  }
};

const generateNodeId = (nodeType: string): string => {
  return `${nodeType}-${Date.now()}-${nanoid(5)}`;
};

export interface NodeContextMenuProps {
  open: boolean;
  /** Menu position: screen coordinates */
  left: number;
  top: number;
  /** Node id at right-click point; null means blank canvas */
  contextNodeId: string | null;
  /** Screen coordinates at right-click, used when pasting */
  clientX: number;
  clientY: number;
  onClose: () => void;
  yjsUndo?: () => void;
  yjsRedo?: () => void;
  yjsCanUndo?: boolean;
  yjsCanRedo?: boolean;
}

/**
 * Image editor flow context menu: matches project canvas menu except pane has no “add asset”
 * entries and the node menu omits Group / Ungroup.
 */
const NodeContextMenu: FC<NodeContextMenuProps> = ({
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

  const { getNodes, getEdges, screenToFlowPosition } = useReactFlow();
  const { onNodesChange, onEdgesChange, onConnect } = useMixedEditorStore();

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

  const addNodesBatch = (newNodes: Node[]) => {
    if (newNodes.length === 0) return;
    const allNodes = getNodes();
    onNodesChange([
      ...allNodes.map((n) => ({ type: 'select' as const, id: n.id, selected: false })),
      ...newNodes.map((n) => ({ type: 'add' as const, item: { ...n, selected: false } })),
    ]);
  };

  const handleCopy = () => {
    const targetNodes = getTargetNodesForAction();
    if (targetNodes.length === 0) return;

    const allNodes = getNodes();

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

  const handleDelete = () => {
    const targetNodes = getTargetNodesForAction();
    if (targetNodes.length === 0) return;
    const allNodes = getNodes();
    const currentEdges = getEdges();
    const nodeIdsToRemove = new Set<string>(targetNodes.map((n) => n.id));
    targetNodes.forEach((n) => {
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

  const handleCut = () => {
    handleCopy();
    handleDelete();
  };

  const handlePaste = async () => {
    const data = await readFromClipboard();
    if (!data?.nodes?.length) return;
    const position = screenToFlowPosition({ x: clientX, y: clientY });
    const nodeIdMap = new Map<string, string>();

    type PastedNode = Node & {
      parentId?: string;
      parentNode?: string;
    };

    const pastedNodes = data.nodes as PastedNode[];

    pastedNodes.forEach((node) => {
      nodeIdMap.set(node.id, generateNodeId(String(node.type || 'node')));
    });

    const nodeMap = new Map<string, PastedNode>();
    pastedNodes.forEach((n) => nodeMap.set(n.id, n));

    const getOriginalAbs = (node: PastedNode): { x: number; y: number } => {
      const rawParentId = node.parentId ?? node.parentNode;
      if (!rawParentId) {
        return { x: node.position.x, y: node.position.y };
      }
      const parent = nodeMap.get(rawParentId);
      if (!parent || parent.type !== 'group') {
        return { x: node.position.x, y: node.position.y };
      }

      const style = (parent.style ?? {}) as { width?: number; height?: number };
      const w = Number(style.width) || 0;
      const h = Number(style.height) || 0;
      if (!w || !h) {
        return { x: node.position.x, y: node.position.y };
      }

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

    const anchorNode = (() => {
      const topLevelGroup = pastedNodes.find((n) => n.type === 'group' && !n.parentId && !n.parentNode);
      if (topLevelGroup) return topLevelGroup;
      const anyGroup = pastedNodes.find((n) => n.type === 'group');
      if (anyGroup) return anyGroup;
      return pastedNodes[0];
    })();

    const firstAbs = originalAbsById.get(anchorNode.id)!;

    const delta = {
      x: position.x - firstAbs.x + pasteOffset.x,
      y: position.y - firstAbs.y + pasteOffset.y,
    };

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

    const allNodesBeforePaste = getNodes();
    const maxZIndex = allNodesBeforePaste.reduce((max, node) => {
      const zIndex = (node as Node & { zIndex?: number }).zIndex ?? 0;
      return Math.max(max, zIndex);
    }, 0);
    const pasteBaseZIndex = maxZIndex + 1;
    newNodes.forEach((n) => {
      (n as Node & { zIndex?: number }).zIndex = pasteBaseZIndex;
    });

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

    addNodesBatch(newNodes);
    newEdges.forEach((e) =>
      onConnect({
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? null,
        targetHandle: e.targetHandle ?? null,
      }),
    );
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

      let newPosition = {
        x: node.position.x + duplicateOffset.x,
        y: node.position.y + duplicateOffset.y,
      };

      if (rawParentId && nodeIdSet.has(rawParentId)) {
        const parent = nodeById.get(rawParentId);
        if (parent && parent.type === 'group') {
          const parentNewId = nodeIdMap.get(rawParentId);
          if (parentNewId) {
            nextParentId = parentNewId;
            newPosition = { ...node.position };
          }
        }
      } else if (rawParentId) {
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

    addNodesBatch(newNodes);
    newEdges.forEach((e) =>
      onConnect({
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? null,
        targetHandle: e.targetHandle ?? null,
      }),
    );
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

  const isPaneMenu = contextNodeId === null;
  const showNodeActions = contextNodeId !== null || getTargetNodesForAction().length > 0;

  const itemBase =
    'flex w-full min-h-8 items-center justify-between gap-3 rounded-[4px] px-2 py-[4px] text-xs text-text-default-base';
  const itemInteractive = 'cursor-pointer hover:bg-background-default-secondary';
  const itemDisabled = 'opacity-50 cursor-not-allowed';

  const shortcutClass = 'text-content-tertiary shrink-0';

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
      onClick: () => clipboardHasData && void handlePaste(),
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
      disabled: !showNodeActions,
      onClick: () => showNodeActions && handleCut(),
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
    { type: 'divider' },
    {
      key: 'delete',
      label: 'Delete',
      shortcut: 'backspace/del',
      disabled: !showNodeActions,
      onClick: () => showNodeActions && handleDelete(),
      icon: 'project-delete-icon',
    },
  ];

  const menuItems = isPaneMenu ? paneMenuItems : nodeMenuItems;

  if (!open) return null;

  const menuContent = (
    <div
      ref={refs.setFloating}
      data-image-editor-context-menu='true'
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
